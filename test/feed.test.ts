import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { FeedRunner, FeedStore, type FeedMailer, type FeedReader, type MailMessage } from '../src/feed.ts';
import type { FeedItem } from '../src/providers/wordpress.ts';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BINDING = {
  baseUrl: 'https://public-feed.example.org/wp-json/wp/v2/posts',
  notificationEnabled: true,
  from: 'Test Sender <sender@example.org>',
  to: 'recipient@example.org',
  bcc: 'copy@example.org',
  replyTo: 'reply@example.org',
};

function item(id: string, title = `Post ${id}`): FeedItem {
  return {
    sourceId: id, title, url: `https://public-feed.example.org/posts/${id}`,
    publishedAt: '2026-10-01T00:00:00.000Z', modifiedAt: '2026-10-02T00:00:00.000Z',
  };
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'feed-state-test-'));
  const path = join(directory, 'feed.sqlite');
  let store = new FeedStore(path, BINDING);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    path,
    get store() { return store; },
    reopen() { store.close(); store = new FeedStore(path, BINDING); return store; },
  };
}

function snapshotReader(items: FeedItem[]): FeedReader {
  return { read: async () => structuredClone(items) };
}

function collectingMailer(messages: MailMessage[]): FeedMailer {
  return { send: async (message) => {
    messages.push(structuredClone(message));
    return { id: `provider-message-${messages.length}` };
  } };
}

type RunResult = ReturnType<FeedStore['status']> & {
  change: null | { baseline: boolean; added: number; updated: number; removed: number };
};

async function run(runner: FeedRunner): Promise<RunResult> {
  return await runner.run() as RunResult;
}

test('the first complete snapshot establishes a baseline without sending mail', async (t) => {
  const { store } = fixture(t);
  const messages: MailMessage[] = [];
  let reads = 0;
  const reader = { read: async () => { reads++; return [item('1'), item('2')]; } };
  const runner = new FeedRunner(store, reader, collectingMailer(messages), { clock: () => NOW, pollIntervalMs: MINUTE });
  const first = await run(runner);
  assert.deepEqual(first.change, { baseline: true, added: 2, updated: 0, removed: 0 });
  assert.equal(first.items, 2);
  assert.equal(first.pending, 0);
  assert.equal(first.healthy, true);
  assert.deepEqual(messages, []);
  const repeated = await run(runner);
  assert.equal(repeated.change, null);
  assert.equal(reads, 1, 'a tick before the next polling deadline must not hit the feed');
});

test('observation mode tracks changes without building a mail backlog', async (t) => {
  const { store } = fixture(t);
  let now = NOW;
  let items = [item('1')];
  const messages: MailMessage[] = [];
  const runner = new FeedRunner(store, { read: async () => structuredClone(items) }, collectingMailer(messages), {
    clock: () => now, pollIntervalMs: MINUTE, notificationsEnabled: false,
  });
  await run(runner);
  now += MINUTE;
  items = [item('1', 'Updated title'), item('2')];
  const changed = await run(runner);
  assert.deepEqual(changed.change, { baseline: false, added: 1, updated: 1, removed: 0 });
  assert.equal(changed.items, 2);
  assert.equal(changed.pending, 0);
  assert.equal(changed.healthy, true);
  assert.deepEqual(messages, []);
  assert.deepEqual(store.due(now), []);
});

test('a changed snapshot creates one immutable digest that survives a restart', async (t) => {
  const state = fixture(t);
  state.store.accept([item('1'), item('2')], NOW, MINUTE);
  assert.deepEqual(state.store.accept([item('2', 'Revised post 2'), item('3')], NOW + MINUTE, MINUTE), {
    baseline: false, added: 1, updated: 1, removed: 1,
  });
  const [queued] = state.store.due(NOW + MINUTE);
  assert.ok(queued);
  assert.match(queued.subject, /1 added, 1 updated, 1 removed/);
  assert.match(queued.text, /Revised post 2/);
  assert.match(queued.text, /posts\/1/);
  const beforeRestart = structuredClone(queued);
  state.reopen();
  assert.deepEqual(state.store.due(NOW + MINUTE), [beforeRestart]);
  const messages: MailMessage[] = [];
  const runner = new FeedRunner(state.store, snapshotReader([]), collectingMailer(messages), {
    clock: () => NOW + MINUTE, pollIntervalMs: MINUTE,
  });
  const delivered = await run(runner);
  assert.equal(delivered.delivered, 1);
  assert.equal(delivered.pending, 0);
  assert.deepEqual(messages, [{ subject: queued.subject, text: queued.text, idempotencyKey: queued.idempotencyKey }]);
  state.reopen();
  assert.deepEqual(state.store.due(NOW + MINUTE), []);
  const unchanged = state.store.accept([item('2', 'Revised post 2'), item('3')], NOW + 2 * MINUTE, MINUTE);
  assert.deepEqual(unchanged, { baseline: false, added: 0, updated: 0, removed: 0 });
  assert.deepEqual(state.store.due(NOW + 2 * MINUTE), []);
});

test('large multilingual digests stay below the provider byte limit', (t) => {
  const { store } = fixture(t);
  const largeItem = (id: number, suffix = ''): FeedItem => ({
    ...item(String(id), '数学𐍈'.repeat(400) + suffix),
    url: `https://public-feed.example.org/${'a'.repeat(4000)}?id=${id}`,
  });
  store.accept(Array.from({ length: 40 }, (_, i) => largeItem(i + 1)), NOW, MINUTE);
  store.accept(Array.from({ length: 40 }, (_, i) => largeItem(i + 21, ' updated')), NOW + MINUTE, MINUTE);
  const [job] = store.due(NOW + MINUTE);
  assert.ok(job);
  assert.match(job.subject, /20 added, 20 updated, 20 removed/);
  assert.ok(Buffer.byteLength(job.text, 'utf8') <= 65_536, 'Resend caps plain text at 64 KiB');
  assert.match(job.text, /omitted/);
});

test('a provider acceptance followed by a lost acknowledgement reuses the exact payload and key', async (t) => {
  const state = fixture(t);
  state.store.accept([item('1')], NOW, MINUTE);
  state.store.accept([item('1'), item('2')], NOW + MINUTE, MINUTE);
  let now = NOW + MINUTE;
  const sent: MailMessage[] = [];
  const accepted = new Map<string, { payload: MailMessage; id: string }>();
  const mailer: FeedMailer = {
    send: async (message) => {
      sent.push(structuredClone(message));
      const earlier = accepted.get(message.idempotencyKey);
      if (earlier) {
        assert.deepEqual(message, earlier.payload, 'a key must never be reused for a changed payload');
        return { id: earlier.id };
      }
      accepted.set(message.idempotencyKey, { payload: structuredClone(message), id: 'one-actual-email' });
      throw { code: 'resend_transport_error', terminal: false };
    },
  };
  const reader = snapshotReader([item('1'), item('2')]);
  await run(new FeedRunner(state.store, reader, mailer, { clock: () => now, pollIntervalMs: MINUTE }));
  assert.equal(accepted.size, 1);
  assert.equal(state.store.status(now, 3 * MINUTE).pending, 1);
  state.reopen();
  now += MINUTE;
  const retried = await run(new FeedRunner(state.store, reader, mailer, { clock: () => now, pollIntervalMs: MINUTE }));
  assert.equal(retried.delivered, 1);
  assert.equal(accepted.size, 1, 'the fake provider should receive only one logical email');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
});

test('a crash after marking an attempt started keeps its idempotency key and original retry window', async (t) => {
  const state = fixture(t);
  state.store.accept([item('1')], NOW, MINUTE);
  state.store.accept([item('1'), item('2')], NOW + MINUTE, MINUTE);
  const [job] = state.store.due(NOW + MINUTE);
  assert.equal(state.store.start(job, NOW + MINUTE), true);
  state.reopen();
  const [recovered] = state.store.due(NOW + MINUTE + 1);
  assert.equal(recovered.idempotencyKey, job.idempotencyKey);
  assert.equal(recovered.attempts, 1);
  assert.equal(recovered.firstAttemptAt, NOW + MINUTE);
  assert.equal(recovered.text, job.text);
});

test('failure while reading a later page leaves the complete previous baseline unchanged', async (t) => {
  const state = fixture(t);
  state.store.accept([item('1'), item('2')], NOW, MINUTE);
  let now = NOW + MINUTE;
  const messages: MailMessage[] = [];
  const reader: FeedReader = {
    read: async () => {
      const firstPage = [item('1', 'Uncommitted change')];
      assert.equal(firstPage.length, 1);
      throw { code: 'schema', message: 'Second page has an invalid post' };
    },
  };
  const failed = await run(new FeedRunner(state.store, reader, collectingMailer(messages), { clock: () => now, pollIntervalMs: MINUTE }));
  assert.equal(failed.lastError, 'schema');
  assert.equal(failed.lastSuccessAt, NOW);
  assert.equal(failed.items, 2);
  assert.equal(failed.pending, 0);
  assert.deepEqual(messages, []);
  state.reopen();
  now += MINUTE;
  const restored = await run(new FeedRunner(state.store, snapshotReader([item('1'), item('2')]), collectingMailer(messages), {
    clock: () => now, pollIntervalMs: MINUTE,
  }));
  assert.deepEqual(restored.change, { baseline: false, added: 0, updated: 0, removed: 0 });
  assert.equal(restored.lastError, null);
  assert.deepEqual(messages, []);
});

test('an invalid duplicate-ID snapshot rolls back both baseline changes and queued mail', (t) => {
  const { store } = fixture(t);
  store.accept([item('1'), item('2')], NOW, MINUTE);
  assert.throws(() => store.accept([item('1', 'Wrong'), item('1', 'Duplicate')], NOW + MINUTE, MINUTE));
  assert.equal(store.status(NOW + MINUTE, 3 * MINUTE).lastSuccessAt, NOW);
  assert.deepEqual(store.due(NOW + MINUTE), []);
  assert.deepEqual(store.accept([item('1'), item('2')], NOW + 2 * MINUTE, MINUTE), {
    baseline: false, added: 0, updated: 0, removed: 0,
  });
});

test('one provider rate limit cools down every pending digest, including newly polled changes, across restart', async (t) => {
  const state = fixture(t);
  state.store.accept([item('1')], NOW, MINUTE);
  state.store.accept([item('1'), item('2')], NOW + MINUTE, MINUTE);
  state.store.accept([item('1'), item('2'), item('3')], NOW + 2 * MINUTE, MINUTE);
  let now = NOW + 2 * MINUTE;
  const attempts: MailMessage[] = [];
  let rateLimit = true;
  const mailer: FeedMailer = { send: async (message) => {
    attempts.push(structuredClone(message));
    if (rateLimit) throw { code: 'resend_http_429', retryAfterMs: 10 * MINUTE, terminal: false };
    return { id: `email-${attempts.length}` };
  } };
  const reader = snapshotReader([item('1'), item('2'), item('3'), item('4')]);
  await run(new FeedRunner(state.store, reader, mailer, { clock: () => now, pollIntervalMs: MINUTE }));
  assert.equal(attempts.length, 1, 'the first rate limit must stop draining the current batch');
  assert.deepEqual(state.store.due(now + 1), []);
  state.reopen();
  now += MINUTE;
  const nextPoll = await run(new FeedRunner(state.store, reader, mailer, { clock: () => now, pollIntervalMs: MINUTE }));
  assert.equal(nextPoll.change?.added, 1);
  assert.equal(nextPoll.pending, 3);
  assert.equal(attempts.length, 1, 'a new digest must not bypass the global provider cooldown');
  state.reopen();
  now = NOW + 12 * MINUTE;
  rateLimit = false;
  const recovered = await run(new FeedRunner(state.store, reader, mailer, { clock: () => now, pollIntervalMs: MINUTE }));
  assert.equal(recovered.pending, 0);
  assert.equal(recovered.delivered, 3);
  assert.equal(attempts.length, 4);
  assert.deepEqual(attempts[0], attempts[1]);
});

test('uncertain deliveries stop at the 23-hour window even after restarting', async (t) => {
  const state = fixture(t);
  state.store.accept([item('1')], NOW, MINUTE);
  state.store.accept([item('1'), item('2')], NOW + MINUTE, MINUTE);
  const [job] = state.store.due(NOW + MINUTE);
  state.store.start(job, NOW + MINUTE);
  state.reopen();
  let calls = 0;
  const result = await run(new FeedRunner(state.store, snapshotReader([item('1'), item('2')]), {
    send: async () => { calls++; return { id: 'must-not-be-sent' }; },
  }, { clock: () => NOW + MINUTE + 23 * HOUR, pollIntervalMs: MINUTE }));
  assert.equal(calls, 0);
  assert.equal(result.blocked, 1);
  assert.equal(result.pending, 0);
  assert.equal(result.healthy, false);
});

test('the retry budget allows at most eight provider attempts', async (t) => {
  const state = fixture(t);
  state.store.accept([item('1')], NOW, MINUTE);
  state.store.accept([item('1'), item('2')], NOW + MINUTE, MINUTE);
  let now = NOW + MINUTE;
  const attempts: MailMessage[] = [];
  const mailer: FeedMailer = { send: async (message) => {
    attempts.push(structuredClone(message));
    throw { code: 'resend_http_503', terminal: false };
  } };
  const runner = new FeedRunner(state.store, snapshotReader([item('1'), item('2')]), mailer, { clock: () => now, pollIntervalMs: MINUTE });
  for (let i = 0; i < 10; i++) { await runner.run(); now += HOUR; }
  assert.equal(attempts.length, 8);
  assert.equal(new Set(attempts.map(message => message.idempotencyKey)).size, 1);
  assert.equal(state.store.status(now, 3 * HOUR).blocked, 1);
  assert.deepEqual(state.store.due(now), []);
});

test('crashing after eight starts cannot reset the attempt budget or its diagnosis', (t) => {
  const state = fixture(t);
  state.store.accept([item('1')], NOW, MINUTE);
  state.store.accept([item('1'), item('2')], NOW + MINUTE, MINUTE);
  for (let attempt = 0; attempt < 8; attempt++) {
    const [job] = state.store.due(NOW + MINUTE + attempt);
    assert.equal(job.attempts, attempt);
    assert.equal(state.store.start(job, NOW + MINUTE + attempt), true);
    state.reopen();
  }
  const [exhausted] = state.store.due(NOW + 2 * MINUTE);
  assert.equal(state.store.start(exhausted, NOW + 2 * MINUTE), false);
  const inspection = new DatabaseSync(state.path);
  try {
    const row = inspection.prepare('SELECT attempts,status,last_error FROM feed_jobs WHERE id=?').get(exhausted.id);
    assert.equal(row?.attempts, 8);
    assert.equal(row?.status, 'blocked');
    assert.equal(row?.last_error, 'resend_attempt_budget_exhausted');
  } finally { inspection.close(); }
});

test('terminal errors block immediately and persist only safe error codes', async (t) => {
  const state = fixture(t);
  state.store.accept([item('1')], NOW, MINUTE);
  state.store.accept([item('1'), item('2')], NOW + MINUTE, MINUTE);
  let calls = 0;
  const result = await run(new FeedRunner(state.store, snapshotReader([]), {
    send: async () => { calls++; throw { code: 'resend_http_401', message: 'Bearer secret-must-not-persist', terminal: true }; },
  }, { clock: () => NOW + MINUTE, pollIntervalMs: MINUTE }));
  assert.equal(calls, 1);
  assert.equal(result.blocked, 1);
  state.reopen();
  assert.deepEqual(state.store.due(NOW + 24 * HOUR), []);
  const inspection = new DatabaseSync(state.path);
  try {
    const stored = inspection.prepare('SELECT last_error FROM feed_jobs').get();
    assert.equal(stored?.last_error, 'resend_http_401');
    assert.equal(JSON.stringify(stored).includes('secret-must-not-persist'), false);
  } finally { inspection.close(); }
});

for (const [field, value] of [
  ['baseUrl', 'https://different-feed.example.org/posts'],
  ['from', 'Other Sender <other-sender@example.org>'],
  ['to', 'other-recipient@example.org'],
  ['bcc', 'other-copy@example.org'],
  ['replyTo', 'other-reply@example.org'],
  ['notificationEnabled', false],
] as const) {
  test(`changing ${field} cannot reroute previously queued mail`, (t) => {
    const state = fixture(t);
    state.store.accept([item('1')], NOW, MINUTE);
    state.store.accept([item('1'), item('2')], NOW + MINUTE, MINUTE);
    const [original] = state.store.due(NOW + MINUTE);
    assert.throws(() => new FeedStore(state.path, { ...BINDING, [field]: value }));
    state.reopen();
    assert.deepEqual(state.store.due(NOW + MINUTE), [original]);
  });
}

test('overlapping runner calls share one read and one delivery', { timeout: 5_000 }, async (t) => {
  const { store } = fixture(t);
  store.accept([item('1')], NOW, MINUTE);
  let finishRead!: (items: FeedItem[]) => void;
  let announceRead!: () => void;
  const started = new Promise<void>((resolve) => { announceRead = resolve; });
  const reading = new Promise<FeedItem[]>((resolve) => { finishRead = resolve; });
  let reads = 0;
  const messages: MailMessage[] = [];
  const runner = new FeedRunner(store, { read: async () => { reads++; announceRead(); return reading; } }, collectingMailer(messages), {
    clock: () => NOW + MINUTE, pollIntervalMs: MINUTE,
  });
  const first = runner.run();
  await started;
  const concurrent = runner.run();
  assert.equal(first, concurrent);
  finishRead([item('1'), item('2')]);
  await Promise.all([first, concurrent]);
  assert.equal(reads, 1);
  assert.equal(messages.length, 1);
  assert.equal(store.status(NOW + MINUTE, 3 * MINUTE).delivered, 1);
});

test('job failure and provider-wide cooldown commit atomically', (t) => {
  const state = fixture(t);
  state.store.accept([item('1')], NOW, MINUTE);
  state.store.accept([item('1'), item('2')], NOW + MINUTE, MINUTE);
  state.store.accept([item('1'), item('2'), item('3')], NOW + 2 * MINUTE, MINUTE);
  const [job] = state.store.due(NOW + 2 * MINUTE);
  state.store.start(job, NOW + 2 * MINUTE);
  const fault = new DatabaseSync(state.path);
  try {
    const before = fault.prepare('SELECT status, next_attempt_at, last_error FROM feed_jobs WHERE id=?').get(job.id);
    fault.exec(`CREATE TRIGGER fail_cooldown_save BEFORE UPDATE ON feed_meta
      WHEN NEW.key = 'state' AND json_extract(NEW.value, '$.mailNextAttemptAt') > 0
      BEGIN SELECT RAISE(ABORT, 'simulated durable state write failure'); END;`);
    assert.throws(() => state.store.failed(job, { code: 'resend_http_429', retryAfterMs: 10 * MINUTE }, NOW + 2 * MINUTE));
    const after = fault.prepare('SELECT status, next_attempt_at, last_error FROM feed_jobs WHERE id=?').get(job.id);
    assert.deepEqual(after, before, 'failure must roll back the job update when its shared cooldown cannot commit');
  } finally { fault.close(); }
});
