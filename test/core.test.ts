import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { IntegrationStore } from '../src/store.ts';
import type { Summary } from '../src/domain.ts';

const NOW = 1_800_000_000_000;

function event(deliveryId = 'delivery-1', revision = 1, changes: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    deliveryId,
    order: {
      id: 'order-1',
      showId: 'show-1',
      revision,
      tickets: 4,
      refundedTickets: 0,
      grossCents: 10_001,
      refundedCents: 0,
      currency: 'USD',
      ...changes,
    },
  };
}

function storeFor(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-sync-test-'));
  const store = new IntegrationStore(join(dir, 'state.sqlite'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

function summary(overrides: Partial<Summary> = {}): Summary {
  return { showId: 'show-1', orders: 1, netTickets: 4, netCents: 10_001, currency: 'USD', ...overrides };
}

test('duplicate deliveries and reordered snapshots cannot inflate totals', (t) => {
  const store = storeFor(t);
  const first = event();
  assert.equal(store.ingest(first, NOW).status, 'accepted');
  assert.equal(store.ingest(first, NOW + 1).status, 'duplicate');
  assert.equal(store.ingest(event('delivery-3', 3, { refundedTickets: 1, refundedCents: 2_499 }), NOW + 2).status, 'accepted');
  assert.equal(store.ingest(event('delivery-2', 2), NOW + 3).status, 'stale');
  assert.deepEqual(store.summaries(), [summary({ netTickets: 3, netCents: 7_502 })]);
});

test('partial refunds retain exact integer cents and separate order totals', (t) => {
  const store = storeFor(t);
  store.ingest(event('a', 1, { refundedTickets: 1, refundedCents: 2_499 }), NOW);
  store.ingest(event('b', 1, { id: 'order-2', tickets: 2, grossCents: 999 }), NOW + 1);
  assert.deepEqual(store.summaries(), [summary({ orders: 2, netTickets: 5, netCents: 8_501 })]);
  store.ingest(event('c', 2, { refundedTickets: 4, refundedCents: 10_001 }), NOW + 2);
  assert.deepEqual(store.summaries(), [summary({ orders: 2, netTickets: 2, netCents: 999 })]);
});

test('a reused delivery ID with different content is quarantined', (t) => {
  const store = storeFor(t);
  store.ingest(event(), NOW);
  const result = store.ingest(event('delivery-1', 2, { refundedTickets: 2, refundedCents: 5_000 }), NOW + 1);
  assert.equal(result.status, 'quarantined');
  assert.deepEqual(store.summaries(), [summary()]);
});

test('a conflicting equal revision cannot overwrite an accepted snapshot', (t) => {
  const store = storeFor(t);
  store.ingest(event(), NOW);
  assert.equal(store.ingest(event('conflict', 1, { tickets: 99 }), NOW + 1).status, 'quarantined');
  assert.deepEqual(store.summaries(), [summary()]);
});

test('equivalent snapshots arriving with new delivery IDs do not add orders', (t) => {
  const store = storeFor(t);
  store.ingest(event(), NOW);
  const status = store.ingest(event('redelivered'), NOW + 1).status;
  assert.notEqual(status, 'accepted');
  assert.deepEqual(store.summaries(), [summary()]);
});

test('unsupported schema versions are quarantined without altering accepted data', (t) => {
  const store = storeFor(t);
  store.ingest(event(), NOW);
  assert.equal(store.ingest({ ...event('unknown', 2), schemaVersion: 99 }, NOW + 1).status, 'quarantined');
  assert.deepEqual(store.summaries(), [summary()]);
});

for (const [name, changes] of [
  ['negative tickets', { tickets: -1 }],
  ['fractional tickets', { tickets: 1.5 }],
  ['negative refunded tickets', { refundedTickets: -1 }],
  ['too many refunded tickets', { refundedTickets: 5 }],
  ['negative gross cents', { grossCents: -1 }],
  ['fractional cents', { refundedCents: 0.5 }],
  ['unsafe integer cents', { grossCents: Number.MAX_SAFE_INTEGER + 1 }],
  ['negative refunded cents', { refundedCents: -1 }],
  ['over-refunded cents', { refundedCents: 10_002 }],
] as const) {
  test(`${name} is rejected without corrupting existing totals`, (t) => {
    const store = storeFor(t);
    store.ingest(event(), NOW);
    assert.equal(store.ingest(event('invalid', 2, changes), NOW + 1).status, 'quarantined');
    assert.deepEqual(store.summaries(), [summary()]);
  });
}

test('schema v2 normalizes to the same projection and revision ordering', (t) => {
  const store = storeFor(t);
  store.ingest(event(), NOW);
  assert.equal(store.ingest({
    schemaVersion: 2,
    deliveryId: 'v2',
    order: {
      id: 'order-1', showId: 'show-1', version: 2,
      quantities: { sold: 4, refunded: 1 },
      amounts: { gross: 10_001, refunded: 2_499, currency: 'USD' },
    },
  }, NOW + 1).status, 'accepted');
  assert.equal(store.ingest(event('late-v1', 1), NOW + 2).status, 'stale');
  assert.deepEqual(store.summaries(), [summary({ netTickets: 3, netCents: 7_502 })]);
});

test('accepted snapshots, deduplication receipts, and pending work survive reopening', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-sync-reopen-'));
  const path = join(dir, 'state.sqlite');
  let store = new IntegrationStore(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.ingest(event(), NOW);
  store.close();
  store = new IntegrationStore(path);
  assert.deepEqual(store.summaries(), [summary()]);
  assert.equal(store.ingest(event(), NOW + 1).status, 'duplicate');
  const pending = store.due(NOW + 1);
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].summary, summary());
  store.complete(pending[0], NOW + 2);
  store.close();
  store = new IntegrationStore(path);
  assert.deepEqual(store.due(NOW + 3), []);
});

test('acknowledging an in-flight older revision cannot delete newer work', (t) => {
  const store = storeFor(t);
  store.ingest(event(), NOW);
  const [inFlight] = store.due(NOW);
  assert.ok(inFlight);
  store.ingest(event('next', 2, { refundedTickets: 1, refundedCents: 2_499 }), NOW + 1);
  store.complete(inFlight, NOW + 2);
  const pending = store.due(NOW + 3);
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0].version, inFlight.version);
  assert.deepEqual(pending[0].summary, summary({ netTickets: 3, netCents: 7_502 }));
  store.complete(pending[0], NOW + 4);
  assert.deepEqual(store.due(NOW + 5), []);
});

test('Retry-After postpones work across a restart', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-sync-retry-'));
  const path = join(dir, 'state.sqlite');
  let store = new IntegrationStore(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.ingest(event(), NOW);
  const [delivery] = store.due(NOW);
  store.fail(delivery, NOW + 1, 'rate limited', 60_000);
  store.close();
  store = new IntegrationStore(path);
  assert.deepEqual(store.due(NOW + 59_999), []);
  const retry = store.due(NOW + 60_002);
  assert.equal(retry.length, 1);
  assert.ok(retry[0].attempts > delivery.attempts);
});

test('new order snapshots coalesce without bypassing provider Retry-After', (t) => {
  const store = storeFor(t);
  store.ingest(event(), NOW);
  store.fail(store.due(NOW)[0], NOW + 1, 'rate limited', 60_000);
  store.ingest(event('refund', 2, { refundedTickets: 1, refundedCents: 2_499 }), NOW + 2);
  assert.deepEqual(store.due(NOW + 3), []);
  const [latest] = store.due(NOW + 60_002);
  assert.ok(latest);
  assert.deepEqual(latest.summary, summary({ netTickets: 3, netCents: 7_502 }));
  assert.equal(latest.attempts, 1);
});

test('repeated failures exhaust a finite retry budget', (t) => {
  const store = storeFor(t);
  store.ingest(event(), NOW);
  let now = NOW;
  let failedAttempts = 0;
  for (let i = 0; i < 20; i += 1) {
    const [delivery] = store.due(now);
    if (!delivery) break;
    store.fail(delivery, now, 'upstream unavailable');
    failedAttempts += 1;
    now += 24 * 60 * 60 * 1_000;
  }
  assert.ok(failedAttempts > 1, 'transient failures should receive retries');
  assert.ok(failedAttempts < 20, 'retry budget should eventually stop automatic delivery');
  assert.deepEqual(store.due(now + 365 * 24 * 60 * 60 * 1_000), []);
});

test('terminal provider failures stop automatic delivery', (t) => {
  const store = storeFor(t);
  store.ingest(event(), NOW);
  const [delivery] = store.due(NOW);
  store.fail(delivery, NOW + 1, 'permission denied', undefined, true);
  assert.deepEqual(store.due(NOW + 365 * 24 * 60 * 60 * 1_000), []);
  assert.deepEqual(store.summaries(), [summary()]);
});

test('new snapshots stay blocked until an operator explicitly retries the latest summary', (t) => {
  const store = storeFor(t);
  store.ingest(event(), NOW);
  const [delivery] = store.due(NOW);
  store.fail(delivery, NOW + 1, 'credentials expired', undefined, true);
  store.ingest(event('refund', 2, { refundedTickets: 1, refundedCents: 2_499 }), NOW + 2);
  assert.deepEqual(store.due(NOW + 60_000), []);
  assert.equal(store.retryBlocked('not-a-known-show', NOW + 60_001), false);
  assert.equal(store.retryBlocked('show-1', NOW + 60_002), true);
  const [retry] = store.due(NOW + 60_003);
  assert.ok(retry);
  assert.equal(retry.attempts, 0);
  assert.notEqual(retry.version, delivery.version);
  assert.deepEqual(retry.summary, summary({ netTickets: 3, netCents: 7_502 }));
  assert.equal(store.retryBlocked('show-1', NOW + 60_004), false, 'operator retry must not reset active attempts');
  store.complete(delivery, NOW + 60_005);
  assert.equal(store.due(NOW + 60_006).length, 1, 'an old response cannot acknowledge the explicit retry');
});

test('terminal blocks and explicit recovery survive restarting the process', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-sync-block-'));
  const path = join(dir, 'state.sqlite');
  let store = new IntegrationStore(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.ingest(event(), NOW);
  store.fail(store.due(NOW)[0], NOW + 1, 'permission denied', undefined, true);
  store.close();
  store = new IntegrationStore(path);
  assert.deepEqual(store.due(NOW + 60_000), []);
  assert.equal(store.retryBlocked('show-1', NOW + 60_001), true);
  store.close();
  store = new IntegrationStore(path);
  const [retry] = store.due(NOW + 60_002);
  assert.ok(retry);
  assert.equal(retry.attempts, 0);
  assert.deepEqual(retry.summary, summary());
});

test('provider backoff from an older in-flight request constrains newer snapshots', (t) => {
  const store = storeFor(t);
  store.ingest(event(), NOW);
  const [inFlight] = store.due(NOW);
  store.ingest(event('next', 2, { refundedTickets: 1, refundedCents: 2_499 }), NOW + 1);
  store.fail(inFlight, NOW + 2, 'rate limited', 60_000);
  assert.deepEqual(store.due(NOW + 3), []);
  const [pending] = store.due(NOW + 60_003);
  assert.ok(pending);
  assert.notEqual(pending.version, inFlight.version);
  assert.equal(pending.attempts, 1);
  assert.deepEqual(pending.summary, summary({ netTickets: 3, netCents: 7_502 }));
});

test('terminal errors from an older in-flight request block the newest pending snapshot', (t) => {
  const store = storeFor(t);
  store.ingest(event(), NOW);
  const [inFlight] = store.due(NOW);
  store.ingest(event('next', 2, { refundedTickets: 1, refundedCents: 2_499 }), NOW + 1);
  store.fail(inFlight, NOW + 2, 'older request denied', undefined, true);
  assert.deepEqual(store.due(NOW + 3), []);
  assert.equal(store.retryBlocked('show-1', NOW + 4), true);
  const pending = store.due(NOW + 5);
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0].version, inFlight.version);
  assert.deepEqual(pending[0].summary, summary({ netTickets: 3, netCents: 7_502 }));
});

test('a late provider failure cannot resurrect work already delivered successfully', (t) => {
  const store = storeFor(t);
  store.ingest(event(), NOW);
  const [older] = store.due(NOW);
  store.ingest(event('next', 2, { refundedTickets: 1, refundedCents: 2_499 }), NOW + 1);
  store.complete(store.due(NOW + 2)[0], NOW + 3);
  store.fail(older, NOW + 4, 'late failure', undefined, true);
  assert.deepEqual(store.due(NOW + 5), []);
  assert.equal(store.retryBlocked('show-1', NOW + 6), false);
});

test('reconciliation cannot bypass a provider backoff or terminal failure', (t) => {
  const store = storeFor(t);
  store.ingest(event(), NOW);
  const [delivery] = store.due(NOW);
  store.fail(delivery, NOW + 1, 'rate limited', 60_000);
  store.reconcile([], NOW + 2);
  assert.deepEqual(store.due(NOW + 3), []);
  const [retry] = store.due(NOW + 60_002);
  assert.ok(retry);
  store.fail(retry, NOW + 60_003, 'invalid credentials', undefined, true);
  store.reconcile([], NOW + 60_004);
  assert.deepEqual(store.due(NOW + 365 * 24 * 60 * 60 * 1_000), []);
});

test('duplicate, stale, and invalid events cannot hide a stalled data feed', (t) => {
  const store = storeFor(t);
  const current = event('current', 2);
  store.ingest(current, NOW);
  store.complete(store.due(NOW)[0], NOW + 1);
  store.ingest(current, NOW + 60_001);
  store.ingest(event('older', 1), NOW + 60_002);
  store.ingest(event('invalid', 3, { refundedCents: -1 }), NOW + 60_003);
  const health = store.health(NOW + 60_004, 60_000) as { stale: boolean; lastAcceptedAt: number | null };
  assert.equal(health.stale, true);
  assert.equal(health.lastAcceptedAt, NOW);
});

test('reconciliation repairs known-show drift and ignores unrelated CRM rows', (t) => {
  const store = storeFor(t);
  store.ingest(event(), NOW);
  const [delivery] = store.due(NOW);
  store.complete(delivery, NOW + 1);
  const unrelated = summary({ showId: 'outside-this-integration', orders: 12, netTickets: 60 });
  const remote = [summary({ netTickets: 999 }), unrelated];
  const original = structuredClone(remote);
  assert.deepEqual(store.reconcile(remote, NOW + 2), ['show-1']);
  assert.deepEqual(remote, original, 'reconciliation must not mutate caller-owned CRM records');
  const repairs = store.due(NOW + 3);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].showId, 'show-1');
  assert.deepEqual(repairs[0].summary, summary());
  store.complete(repairs[0], NOW + 4);
  assert.deepEqual(store.reconcile([summary(), unrelated], NOW + 5), []);
  assert.deepEqual(store.due(NOW + 6), []);
});

test('reconciliation recreates a missing known CRM projection', (t) => {
  const store = storeFor(t);
  store.ingest(event(), NOW);
  store.complete(store.due(NOW)[0], NOW + 1);
  assert.deepEqual(store.reconcile([], NOW + 2), ['show-1']);
  assert.deepEqual(store.due(NOW + 3).map((delivery) => delivery.summary), [summary()]);
});
