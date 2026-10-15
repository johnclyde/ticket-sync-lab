import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { FeedItem } from './providers/wordpress.ts';

export interface MailMessage { subject: string; text: string; idempotencyKey: string }
export interface FeedReader { read(): Promise<FeedItem[]> }
export interface FeedMailer { send(message: MailMessage): Promise<{ id: string }> }
interface Job extends MailMessage { id: string; attempts: number; firstAttemptAt: number | null; nextAttemptAt: number }
interface State { initialized: boolean; lastSuccessAt: number | null; lastError: string | null; nextPollAt: number; mailNextAttemptAt: number }
const RETRY_WINDOW = 23 * 60 * 60 * 1000;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[a-z0-9_]{1,80}$/.test(code) ? code : 'integration_error';
}
function retryDelay(error: unknown, fallback: number): number {
  const value = (error as { retryAfterMs?: unknown })?.retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.max(fallback, Math.min(value, 24 * 60 * 60 * 1000)) : fallback;
}

// This store is for one configured feed and one sender/recipient configuration.
// Store only public post metadata; never API keys or raw provider errors.
export class FeedStore {
  private db: DatabaseSync;
  constructor(path: string, binding: unknown) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS feed_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feed_items (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feed_jobs (
        id TEXT PRIMARY KEY, subject TEXT NOT NULL, text TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        first_attempt_at INTEGER, next_attempt_at INTEGER NOT NULL,
        delivered_id TEXT, last_error TEXT
      );`);
    const existing = this.db.prepare('SELECT value FROM feed_meta WHERE key=?').get('binding') as { value: string } | undefined;
    const fingerprint = hash(binding);
    if (existing && existing.value !== fingerprint) {
      this.db.close();
      throw new Error('feed_configuration_changed_use_a_separate_database');
    }
    this.db.prepare('INSERT OR IGNORE INTO feed_meta VALUES (?,?)').run('binding', fingerprint);
    this.db.prepare('INSERT OR IGNORE INTO feed_meta VALUES (?,?)').run('state', JSON.stringify({
      initialized: false, lastSuccessAt: null, lastError: null, nextPollAt: 0, mailNextAttemptAt: 0,
    }));
  }
  private state(): State {
    return JSON.parse((this.db.prepare('SELECT value FROM feed_meta WHERE key=?').get('state') as { value: string }).value);
  }
  private save(state: State) { this.db.prepare('UPDATE feed_meta SET value=? WHERE key=?').run(JSON.stringify(state), 'state'); }
  canPoll(now: number): boolean { return now >= this.state().nextPollAt; }
  accept(items: FeedItem[], now: number, pollIntervalMs: number, enqueue = true): { baseline: boolean; added: number; updated: number; removed: number } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.state();
      const old = new Map((this.db.prepare('SELECT id,body FROM feed_items').all() as { id: string; body: string }[]).map(row => [row.id, JSON.parse(row.body) as FeedItem]));
      const current = new Map(items.map(item => [item.sourceId, item]));
      if (current.size !== items.length) throw new Error('duplicate_feed_id');
      const added = items.filter(item => !old.has(item.sourceId));
      const updated = items.filter(item => old.has(item.sourceId) && hash(old.get(item.sourceId)) !== hash(item));
      const removed = [...old.values()].filter(item => !current.has(item.sourceId));
      if (enqueue && state.initialized && (added.length || updated.length || removed.length)) {
        const subject = `[Feed watch] ${added.length} added, ${updated.length} updated, ${removed.length} removed`;
        const sections = [['Added', added], ['Updated', updated], ['Removed', removed]] as const;
        const text = [subject, 'Public WordPress post metadata changed.', ...sections.flatMap(([label, rows]) => rows.length
          ? ['', `${label} (${rows.length}):`, ...rows.slice(0, 20).map(item => `${item.title.slice(0, 200)}\n${item.url.slice(0, 1000)}`), ...(rows.length > 20 ? ['Additional items omitted from this digest.'] : [])] : [])].join('\n');
        // Bound UTF-8 bytes, including multibyte titles, below provider limits.
        let boundedText = text;
        if (Buffer.byteLength(boundedText, 'utf8') > 48_000) {
          boundedText = Buffer.from(boundedText, 'utf8').subarray(0, 48_000).toString('utf8')
            + '\nAdditional details omitted to keep the digest bounded.';
        }
        this.db.prepare('INSERT INTO feed_jobs (id,subject,text,status,next_attempt_at) VALUES (?,?,?,?,?)')
          .run(`feed-${randomUUID()}`, subject, boundedText, 'pending', now);
      }
      this.db.exec('DELETE FROM feed_items');
      const insert = this.db.prepare('INSERT INTO feed_items VALUES (?,?)');
      for (const item of items) insert.run(item.sourceId, JSON.stringify(item));
      this.save({ ...state, initialized: true, lastSuccessAt: now, lastError: null, nextPollAt: now + pollIntervalMs });
      this.db.exec('COMMIT');
      return { baseline: !state.initialized, added: added.length, updated: updated.length, removed: removed.length };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  failPoll(error: unknown, now: number, pollIntervalMs: number) {
    const state = this.state();
    this.save({ ...state, lastError: errorCode(error), nextPollAt: now + retryDelay(error, pollIntervalMs) });
  }
  due(now: number): Job[] {
    if (now < this.state().mailNextAttemptAt) return [];
    return (this.db.prepare("SELECT * FROM feed_jobs WHERE status='pending' AND next_attempt_at<=? ORDER BY rowid LIMIT 25").all(now) as Record<string, unknown>[]).map(row => ({
      id: row.id as string, idempotencyKey: row.id as string, subject: row.subject as string, text: row.text as string,
      attempts: row.attempts as number, firstAttemptAt: row.first_attempt_at as number | null, nextAttemptAt: row.next_attempt_at as number,
    }));
  }
  start(job: Job, now: number): boolean {
    if (job.attempts >= 8 || (job.firstAttemptAt !== null && now - job.firstAttemptAt >= RETRY_WINDOW)) {
      this.db.prepare("UPDATE feed_jobs SET status='blocked',last_error=? WHERE id=?").run(job.attempts >= 8 ? 'resend_attempt_budget_exhausted' : 'resend_retry_window_expired', job.id);
      return false;
    }
    this.db.prepare('UPDATE feed_jobs SET first_attempt_at=COALESCE(first_attempt_at,?),attempts=attempts+1 WHERE id=?').run(now, job.id);
    return true;
  }
  delivered(job: Job, id: string) {
    this.db.prepare("UPDATE feed_jobs SET status='delivered',delivered_id=?,last_error=NULL WHERE id=?").run(id, job.id);
  }
  failed(job: Job, error: unknown, now: number) {
    const terminal = (error as { terminal?: unknown })?.terminal === true || job.attempts + 1 >= 8;
    const nextAttemptAt = now + retryDelay(error, Math.min(60_000 * 2 ** job.attempts, 3_600_000));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE feed_jobs SET status=?,last_error=?,next_attempt_at=? WHERE id=?')
        .run(terminal ? 'blocked' : 'pending', errorCode(error), nextAttemptAt, job.id);
      this.save({ ...this.state(), mailNextAttemptAt: nextAttemptAt });
      this.db.exec('COMMIT');
    } catch (failure) { this.db.exec('ROLLBACK'); throw failure; }
  }
  status(now: number, staleAfterMs: number) {
    const state = this.state();
    const count = (status: string) => (this.db.prepare('SELECT count(*) AS n FROM feed_jobs WHERE status=?').get(status) as { n: number }).n;
    const pending = count('pending'), blocked = count('blocked');
    const stale = state.lastSuccessAt === null || now - state.lastSuccessAt > staleAfterMs;
    return { ...state, stale, pending, blocked, delivered: count('delivered'),
      items: (this.db.prepare('SELECT count(*) AS n FROM feed_items').get() as { n: number }).n,
      healthy: !stale && !state.lastError && pending === 0 && blocked === 0 };
  }
  close() { this.db.close(); }
}

// One runner process per database. Durable outbox plus provider deduplication
// handles crash recovery; there is intentionally no distributed worker lease.
export class FeedRunner {
  private running?: Promise<unknown>;
  private store: FeedStore;
  private reader: FeedReader;
  private mailer?: FeedMailer;
  private options: { clock?: () => number; pollIntervalMs?: number; notificationsEnabled?: boolean };
  constructor(store: FeedStore, reader: FeedReader, mailer?: FeedMailer,
    options: { clock?: () => number; pollIntervalMs?: number; notificationsEnabled?: boolean } = {}) {
    this.store = store; this.reader = reader; this.mailer = mailer; this.options = options;
  }
  run(): Promise<unknown> {
    if (!this.running) this.running = this.execute().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async execute() {
    const clock = this.options.clock ?? Date.now;
    let change: unknown = null;
    if (this.store.canPoll(clock())) {
      try { change = this.store.accept(await this.reader.read(), clock(), this.options.pollIntervalMs ?? 900_000, this.options.notificationsEnabled ?? true); }
      catch (error) { this.store.failPoll(error, clock(), this.options.pollIntervalMs ?? 900_000); }
    }
    if (this.mailer) {
      for (const job of this.store.due(clock())) {
        if (!this.store.start(job, clock())) continue;
        try {
          const response = await this.mailer.send({ subject: job.subject, text: job.text, idempotencyKey: job.idempotencyKey });
          this.store.delivered(job, response.id);
        } catch (error) {
          this.store.failed(job, error, clock());
          // A provider limit applies to every queued message, not just this job.
          break;
        }
      }
    }
    return { change, ...this.store.status(clock(), (this.options.pollIntervalMs ?? 900_000) * 3) };
  }
}
