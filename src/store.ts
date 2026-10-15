import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalize } from './domain.ts';
import type { Delivery, IngestResult, NormalizedEvent, Order, Summary } from './domain.ts';

export const RETRY_LIMIT = 8;
export const RETRY_BASE_MS = 1_000;
export const RETRY_CAP_MS = 300_000;
export const RETRY_AFTER_CAP_MS = 86_400_000;

type StoredOrder = Order & { contentHash: string };
type StoredDelivery = { showId: string; version: number; attempts: number };
export type DeliveryStatus = {
  showId: string;
  version: number;
  status: 'pending' | 'delivered' | 'blocked';
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  queuedAt: number;
};

function fingerprint(input: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? '[unserializable]';
  } catch {
    serialized = '[unserializable]';
  }
  return createHash('sha256').update(serialized).digest('hex');
}

function timestamp(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - RETRY_AFTER_CAP_MS) {
    throw new Error('now must be a nonnegative safe millisecond timestamp');
  }
}

function sameSummary(left: Summary, right: Summary): boolean {
  return left.showId === right.showId && left.orders === right.orders &&
    left.netTickets === right.netTickets && left.netCents === right.netCents &&
    left.currency === right.currency;
}

export class IntegrationStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        show_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        tickets INTEGER NOT NULL,
        refunded_tickets INTEGER NOT NULL,
        gross_cents INTEGER NOT NULL,
        refunded_cents INTEGER NOT NULL,
        currency TEXT NOT NULL CHECK (currency = 'USD'),
        content_hash TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS orders_by_show ON orders(show_id);
      CREATE TABLE IF NOT EXISTS receipts (
        delivery_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        outcome TEXT NOT NULL,
        received_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS quarantine (
        content_hash TEXT NOT NULL,
        reason TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        occurrences INTEGER NOT NULL,
        PRIMARY KEY (content_hash, reason)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS deliveries (
        show_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'blocked')),
        attempts INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        queued_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_error TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      ) STRICT;
    `);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private quarantine(hash: string, reason: string, now: number): IngestResult {
    this.db.prepare(`
      INSERT INTO quarantine VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(content_hash, reason) DO UPDATE SET
        last_seen_at = excluded.last_seen_at, occurrences = occurrences + 1
    `).run(hash, reason, now, now);
    return { status: 'quarantined', reason };
  }

  private receipt(event: NormalizedEvent, hash: string, outcome: string, now: number): void {
    this.db.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?)')
      .run(event.deliveryId, hash, outcome, now);
  }

  private queue(showId: string, now: number): void {
    this.db.prepare(`
      INSERT INTO deliveries VALUES (?, 1, 'pending', 0, ?, ?, ?, NULL)
      ON CONFLICT(show_id) DO UPDATE SET
        version = version + 1,
        queued_at = CASE WHEN status = 'delivered' THEN excluded.queued_at ELSE queued_at END,
        attempts = CASE WHEN status = 'delivered' THEN 0 ELSE attempts END,
        next_attempt_at = CASE WHEN status = 'delivered' THEN excluded.next_attempt_at ELSE next_attempt_at END,
        last_error = CASE WHEN status = 'delivered' THEN NULL ELSE last_error END,
        status = CASE WHEN status = 'blocked' THEN 'blocked' ELSE 'pending' END,
        updated_at = excluded.updated_at
    `).run(showId, now, now, now);
  }

  ingest(input: unknown, now = Date.now()): IngestResult {
    timestamp(now);
    let event: NormalizedEvent;
    try {
      event = normalize(input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid event';
      return this.quarantine(fingerprint(input), reason, now);
    }
    const eventHash = fingerprint(event);
    const orderHash = fingerprint(event.order);

    return this.transaction(() => {
      const seen = this.db.prepare('SELECT content_hash AS contentHash, outcome FROM receipts WHERE delivery_id = ?')
        .get(event.deliveryId) as { contentHash: string; outcome: string } | undefined;
      if (seen) {
        if (seen.contentHash !== eventHash) {
          return this.quarantine(eventHash, 'deliveryId reused with different content', now);
        }
        return seen.outcome === 'quarantined'
          ? { status: 'quarantined', reason: 'previously quarantined delivery' }
          : { status: 'duplicate' };
      }

      const previous = this.db.prepare(`
        SELECT id, show_id AS showId, revision, tickets, refunded_tickets AS refundedTickets,
          gross_cents AS grossCents, refunded_cents AS refundedCents, currency, content_hash AS contentHash
        FROM orders WHERE id = ?
      `).get(event.order.id) as StoredOrder | undefined;
      const { order } = event;
      if (previous && previous.showId !== order.showId) {
        this.receipt(event, eventHash, 'quarantined', now);
        return this.quarantine(eventHash, 'order cannot change showId', now);
      }
      if (previous && previous.revision > order.revision) {
        this.receipt(event, eventHash, 'stale', now);
        return { status: 'stale' };
      }
      if (previous && previous.revision === order.revision) {
        if (previous.contentHash !== orderHash) {
          this.receipt(event, eventHash, 'quarantined', now);
          return this.quarantine(eventHash, 'conflicting content at the same order revision', now);
        }
        this.receipt(event, eventHash, 'duplicate', now);
        return { status: 'duplicate' };
      }

      this.db.prepare(`
        INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          revision = excluded.revision, tickets = excluded.tickets,
          refunded_tickets = excluded.refunded_tickets, gross_cents = excluded.gross_cents,
          refunded_cents = excluded.refunded_cents, content_hash = excluded.content_hash
      `).run(order.id, order.showId, order.revision, order.tickets, order.refundedTickets,
        order.grossCents, order.refundedCents, order.currency, orderHash);
      this.receipt(event, eventHash, 'accepted', now);
      this.queue(order.showId, now);
      this.db.prepare(`
        INSERT INTO metadata VALUES ('last_accepted_at', ?)
        ON CONFLICT(key) DO UPDATE SET value = max(value, excluded.value)
      `).run(now);
      return { status: 'accepted' };
    });
  }

  summaries(): Summary[] {
    return this.db.prepare(`
      SELECT show_id AS showId, count(*) AS orders,
        sum(tickets - refunded_tickets) AS netTickets,
        sum(gross_cents - refunded_cents) AS netCents, 'USD' AS currency
      FROM orders GROUP BY show_id ORDER BY show_id
    `).all().map((row) => ({ ...row })) as Summary[];
  }

  due(now = Date.now()): Delivery[] {
    timestamp(now);
    return this.transaction(() => {
      const summaries = new Map(this.summaries().map((summary) => [summary.showId, summary]));
      const pending = this.db.prepare(`
        SELECT show_id AS showId, version, attempts FROM deliveries
        WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, show_id
      `).all(now) as StoredDelivery[];
      return pending.map((delivery) => ({ ...delivery, summary: summaries.get(delivery.showId)! }));
    });
  }

  deliveryStatus(): DeliveryStatus[] {
    return this.db.prepare(`
      SELECT show_id AS showId, version, status, attempts, next_attempt_at AS nextAttemptAt,
        last_error AS lastError, queued_at AS queuedAt
      FROM deliveries ORDER BY show_id
    `).all().map((row) => ({ ...row })) as DeliveryStatus[];
  }

  complete(delivery: Delivery, now = Date.now()): void {
    timestamp(now);
    // A response for an older version must never acknowledge a newer snapshot.
    this.db.prepare(`
      UPDATE deliveries SET status = 'delivered', updated_at = ?, last_error = NULL
      WHERE show_id = ? AND version = ? AND status = 'pending'
    `).run(now, delivery.showId, delivery.version);
  }

  fail(delivery: Delivery, now: number, error: string, retryAfterMs?: number, terminal = false): void {
    timestamp(now);
    this.transaction(() => {
      const current = this.db.prepare(`
        SELECT attempts, version FROM deliveries WHERE show_id = ? AND version >= ? AND status = 'pending'
      `).get(delivery.showId, delivery.version) as { attempts: number; version: number } | undefined;
      if (!current) return;
      const attempts = current.attempts + 1;
      const backoff = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
      const requested = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
        ? Math.min(RETRY_AFTER_CAP_MS, Math.max(0, Math.ceil(retryAfterMs))) : 0;
      const blocked = terminal || attempts >= RETRY_LIMIT;
      // Provider backoff also applies to a newer snapshot received during the request.
      // Only fixed transport codes are retained; arbitrary errors can contain secrets.
      const safeError = /^(crm_http_[0-9]{3}|crm_transport_error)$/.test(error)
        ? error : `delivery failure sha256:${fingerprint(error)}`;
      this.db.prepare(`
        UPDATE deliveries SET status = ?, attempts = ?, next_attempt_at = ?, updated_at = ?, last_error = ?
        WHERE show_id = ? AND version = ? AND status = 'pending'
      `).run(blocked ? 'blocked' : 'pending', attempts, now + Math.max(backoff, requested), now,
        safeError, delivery.showId, current.version);
    });
  }

  reconcile(remote: Summary[], now = Date.now()): string[] {
    timestamp(now);
    if (!Array.isArray(remote)) throw new Error('remote summaries must be an array');
    const remoteByShow = new Map<string, Summary>();
    for (const summary of remote) {
      if (!summary || typeof summary.showId !== 'string' || summary.currency !== 'USD' ||
          ![summary.orders, summary.netTickets, summary.netCents].every((n) => Number.isSafeInteger(n) && n >= 0)) {
        throw new Error('invalid remote summary');
      }
      if (remoteByShow.has(summary.showId)) throw new Error('duplicate remote showId');
      remoteByShow.set(summary.showId, summary);
    }

    return this.transaction(() => {
      const queued: string[] = [];
      for (const summary of this.summaries()) {
        const current = remoteByShow.get(summary.showId);
        if (current && sameSummary(summary, current)) continue;
        const delivery = this.db.prepare('SELECT status FROM deliveries WHERE show_id = ?')
          .get(summary.showId) as { status: string } | undefined;
        // Reconciliation must not reset active backoff or a blocked retry budget.
        if (delivery && delivery.status !== 'delivered') continue;
        this.queue(summary.showId, now);
        queued.push(summary.showId);
      }
      return queued;
    });
  }

  retryBlocked(showId: string, now = Date.now()): boolean {
    timestamp(now);
    // Only an explicit operator action resets a stopped delivery's retry budget.
    return this.db.prepare(`
      UPDATE deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?,
        updated_at = ?, last_error = NULL
      WHERE show_id = ? AND status = 'blocked'
    `).run(now, now, showId).changes > 0;
  }

  health(now = Date.now(), staleAfterMs = 300_000): object {
    timestamp(now);
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 0) throw new Error('invalid staleAfterMs');
    const accepted = this.db.prepare("SELECT value FROM metadata WHERE key = 'last_accepted_at'")
      .get() as { value: number } | undefined;
    const counts = this.db.prepare(`
      SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
        count(*) FILTER (WHERE status = 'blocked') AS blocked,
        count(*) FILTER (WHERE status = 'pending' AND attempts > 0) AS retrying,
        min(queued_at) FILTER (WHERE status IN ('pending', 'blocked')) AS oldest
      FROM deliveries
    `).get() as { pending: number; blocked: number; retrying: number; oldest: number | null };
    const quarantine = this.db.prepare('SELECT coalesce(sum(occurrences), 0) AS count FROM quarantine')
      .get() as { count: number };
    const lastAcceptedAt = accepted?.value ?? null;
    const stale = lastAcceptedAt === null || now - lastAcceptedAt >= staleAfterMs;
    const status = lastAcceptedAt === null ? 'empty' : stale ? 'stale' :
      counts.blocked || counts.retrying ? 'degraded' : 'healthy';
    return {
      status,
      healthy: status === 'healthy',
      lastAcceptedAt,
      stale,
      pending: counts.pending,
      blocked: counts.blocked,
      retrying: counts.retrying,
      quarantined: quarantine.count,
      oldestPendingAgeMs: counts.oldest === null ? null : Math.max(0, now - counts.oldest),
    };
  }

  close(): void {
    this.db.close();
  }
}
