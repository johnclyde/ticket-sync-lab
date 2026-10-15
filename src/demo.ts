import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { IntegrationStore } from './store.ts';
import { DeliveryWorker } from './worker.ts';
import { MockCrm } from './mock-crm.ts';
import { createIntegrationServer, sign } from './server.ts';
import { order, partialRefund, secondOrder } from './fixtures.ts';

const directory = await mkdtemp(join(tmpdir(), 'ticket-sync-lab-'));
const path = join(directory, 'tickets.sqlite');
const webhookSecret = randomBytes(32).toString('hex');
const adminToken = randomBytes(32).toString('hex');
const crmToken = randomBytes(32).toString('hex');
let now = Date.now();
let store = new IntegrationStore(path);
const crm = new MockCrm(crmToken);
const url = await crm.listen();
let worker = new DeliveryWorker(store, { url, token: crmToken, clock: () => now });
const server = createIntegrationServer(store, worker, { webhookSecret, adminToken, clock: () => now });
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
let serverClosed = false;
const checks: string[] = [];
function passed(message: string) { checks.push(message); console.log(`PASS  ${message}`); }
async function webhook(payload: unknown, valid = true) {
  const body = JSON.stringify(payload), timestamp = String(Math.floor(now / 1000));
  const response = await fetch(endpoint + '/webhooks/tickets', {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-ticket-timestamp': timestamp, 'x-ticket-signature': valid ? sign(body, webhookSecret, timestamp) : '0'.repeat(64) },
  });
  return { status: response.status, body: await response.json() };
}

try {
  assert.equal((await webhook(order, false)).status, 401);
  assert.equal((await webhook(order)).status, 202);
  assert.equal((await webhook(order)).body.status, 'duplicate');
  passed('Signed HTTP intake rejects tampering and deduplicates deliveries.');
  assert.equal((await webhook(partialRefund)).status, 202);
  assert.equal((await webhook({ ...order, deliveryId: 'late-arrival' })).body.status, 'stale');
  assert.equal((await webhook(secondOrder)).status, 202);
  const expected = [{ showId: 'show-spring', orders: 2, netTickets: 5, netCents: 25000, currency: 'USD' }];
  assert.deepEqual(store.summaries(), expected);
  passed('A v2 partial refund and an old v1 delivery leave 5 tickets and $250.00.');
  assert.equal((await webhook({ ...order, schemaVersion: 99, deliveryId: 'unknown-schema' })).status, 422);
  assert.deepEqual(store.summaries(), expected);
  passed('An unexpected schema is quarantined without corrupting totals.');

  crm.failures.push({ status: 503 }, { status: 429, retryAfter: '2' });
  assert.equal(await worker.tick(), 0);
  await new Promise<void>(resolve => server.close(() => resolve()));
  serverClosed = true;
  store.close();
  store = new IntegrationStore(path);
  worker = new DeliveryWorker(store, { url, token: crmToken, clock: () => now });
  assert.equal(store.due(now).length, 0);
  now += 1000;
  assert.equal(await worker.tick(), 0);
  now += 1999;
  assert.equal(await worker.tick(), 0);
  now += 1;
  assert.equal(await worker.tick(), 1);
  assert.deepEqual(crm.summaries(), expected);
  assert.equal(new Set(crm.attempts).size, 1);
  passed('A restart preserves the queue; 503 and 429 retries keep the same idempotency key.');

  crm.drift('show-spring', 99);
  assert.deepEqual(await worker.reconcile(), ['show-spring']);
  crm.failures.push({ status: 0, afterCommit: true });
  assert.equal(await worker.tick(), 0);
  const committedWrites = crm.writes;
  now += 1000;
  assert.equal(await worker.tick(), 1);
  assert.equal(crm.writes, committedWrites);
  assert.deepEqual(crm.summaries(), expected);
  passed('Reconciliation repairs CRM drift; a lost acknowledgement does not duplicate the write.');

  now += 300_001;
  const health = store.health(now) as { stale: boolean; quarantined: number };
  assert.equal(health.stale, true);
  assert.equal(health.quarantined, 1);
  passed('Silent feed staleness and quarantined data remain visible to an operator.');
  console.log('\n' + JSON.stringify({ mode: 'synthetic demonstration', checks: checks.length, finalProjection: crm.summaries(), health }, null, 2));
} finally {
  if (!serverClosed) await new Promise<void>(resolve => server.close(() => resolve()));
  await crm.close();
  store.close();
  await rm(directory, { recursive: true, force: true });
}
