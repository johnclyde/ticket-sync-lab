import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { IntegrationStore } from '../src/store.ts';
import { createIntegrationServer, sign } from '../src/server.ts';
import { DeliveryWorker, retryAfter } from '../src/worker.ts';

const NOW = 1_800_000_000_000;
const WEBHOOK_SECRET = 'synthetic-webhook-secret-at-least-32-characters';
const ADMIN_TOKEN = 'synthetic-admin-secret-at-least-32-characters';
const CRM_TOKEN = 'synthetic-crm-token';

function event(deliveryId = 'delivery-1', revision = 1) {
  return {
    schemaVersion: 1, deliveryId,
    order: {
      id: 'order-1', showId: 'show:2026.10', revision,
      tickets: 4, refundedTickets: revision - 1,
      grossCents: 10_000, refundedCents: (revision - 1) * 2_500, currency: 'USD',
    },
  };
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

async function setup(t: TestContext, handler?: Handler) {
  let now = NOW;
  const store = new IntegrationStore(':memory:');
  const crm = createServer((request, response) => {
    Promise.resolve(handler ? handler(request, response) : undefined)
      .then(() => {
        if (!handler) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(request.url === '/shows' ? '[]' : '{}');
        }
      }).catch(() => { response.writeHead(500); response.end(); });
  });
  const servers = [crm];
  t.after(async () => { await Promise.all(servers.map(close)); store.close(); });
  const crmUrl = await listen(crm);
  const worker = new DeliveryWorker(store, { url: crmUrl, token: CRM_TOKEN, clock: () => now });
  const app = createIntegrationServer(store, worker, {
    webhookSecret: WEBHOOK_SECRET, adminToken: ADMIN_TOKEN, clock: () => now,
  });
  servers.push(app);
  const url = await listen(app);
  return { store, worker, url, advance: (ms: number) => { now += ms; } };
}

function signed(body: string, timestamp = String(NOW / 1000)): RequestInit {
  return {
    method: 'POST', body,
    headers: {
      'content-type': 'application/json',
      'x-ticket-timestamp': timestamp,
      'x-ticket-signature': sign(body, WEBHOOK_SECRET, timestamp),
    },
  };
}

test('signed webhooks accept a snapshot once and return a safe duplicate response', async (t) => {
  const { url, store } = await setup(t);
  const body = JSON.stringify(event());
  const first = await fetch(`${url}/webhooks/tickets`, signed(body));
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { status: 'accepted' });
  const replay = await fetch(`${url}/webhooks/tickets`, signed(body));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { status: 'duplicate' });
  assert.equal(store.summaries()[0].orders, 1);
});

test('a tampered body cannot reuse a valid HMAC signature', async (t) => {
  const { url, store } = await setup(t);
  const request = signed(JSON.stringify(event()));
  request.body = JSON.stringify(event('altered', 2));
  const response = await fetch(`${url}/webhooks/tickets`, request);
  assert.equal(response.status, 401);
  assert.deepEqual(store.summaries(), []);
});

test('missing, expired, and excessively future signatures cannot ingest data', async (t) => {
  const { url, store } = await setup(t);
  const body = JSON.stringify(event());
  const unsigned = await fetch(`${url}/webhooks/tickets`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  assert.equal(unsigned.status, 401);
  for (const offset of [-301_000, 301_000]) {
    const response = await fetch(`${url}/webhooks/tickets`, signed(body, String((NOW + offset) / 1000)));
    assert.equal(response.status, 401);
  }
  assert.deepEqual(store.summaries(), []);
});

test('signed malformed JSON is rejected without leaving a partial order', async (t) => {
  const { url, store } = await setup(t);
  const response = await fetch(`${url}/webhooks/tickets`, signed('{"order":'));
  assert.equal(response.status, 400);
  assert.deepEqual(store.summaries(), []);
});

test('oversized webhook requests receive 413 and do not reach ingestion', async (t) => {
  const { url, store } = await setup(t);
  const body = JSON.stringify({ ...event(), padding: 'x'.repeat(65_537) });
  const response = await fetch(`${url}/webhooks/tickets`, signed(body));
  assert.equal(response.status, 413);
  assert.deepEqual(store.summaries(), []);
});

test('operations and reconciliation require the separate admin token', async (t) => {
  let crmCalls = 0;
  const { url } = await setup(t, (_request, response) => {
    crmCalls += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('[]');
  });
  assert.equal((await fetch(`${url}/status`)).status, 401);
  assert.equal((await fetch(`${url}/status`, { headers: { authorization: `Bearer ${WEBHOOK_SECRET}` } })).status, 401);
  assert.equal((await fetch(`${url}/admin/reconcile`, { method: 'POST' })).status, 401);
  assert.equal(crmCalls, 0);
  const headers = { authorization: `Bearer ${ADMIN_TOKEN}` };
  assert.equal((await fetch(`${url}/status`, { headers })).status, 200);
  assert.equal((await fetch(`${url}/admin/reconcile`, { method: 'POST', headers })).status, 200);
  assert.equal(crmCalls, 1);
});

test('only an authenticated operator can reset a blocked delivery', async (t) => {
  const { url, store } = await setup(t);
  store.ingest(event(), NOW);
  store.fail(store.due(NOW)[0], NOW + 1, 'crm_http_401', undefined, true);
  const body = JSON.stringify({ showId: 'show:2026.10' });
  const unsigned = await fetch(`${url}/admin/retry`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  assert.equal(unsigned.status, 401);
  assert.deepEqual(store.due(NOW + 2), []);
  const headers = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };
  const status = await fetch(`${url}/status`, { headers });
  const statusBody = await status.json();
  assert.equal(statusBody.deliveries[0].status, 'blocked');
  assert.equal(statusBody.deliveries[0].lastError, 'crm_http_401');
  const invalid = await fetch(`${url}/admin/retry`, { method: 'POST', headers, body: '{}' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(store.due(NOW + 2), []);
  const authorized = await fetch(`${url}/admin/retry`, { method: 'POST', headers, body });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { queued: true });
  assert.equal(store.due(NOW + 2).length, 1);
  const again = await fetch(`${url}/admin/retry`, { method: 'POST', headers, body });
  assert.deepEqual(await again.json(), { queued: false });
});

test('Retry-After accepts both delay seconds and HTTP dates', () => {
  assert.equal(retryAfter('60', NOW), 60_000);
  assert.equal(retryAfter(new Date(NOW + 60_000).toUTCString(), NOW), 60_000);
  assert.equal(retryAfter(new Date(NOW - 60_000).toUTCString(), NOW), 0);
  assert.equal(retryAfter('not a date', NOW), undefined);
  assert.equal(retryAfter(null, NOW), undefined);
});

test('overlapping worker ticks serialize and a delayed 429 throttles the newest snapshot', { timeout: 10_000 }, async (t) => {
  let respond!: (response: ServerResponse) => void;
  const requestArrived = new Promise<ServerResponse>((resolve) => { respond = resolve; });
  const payloads: Array<{ version: number; summary: { netTickets: number } }> = [];
  let calls = 0;
  const { store, worker, advance } = await setup(t, async (request, response) => {
    calls += 1;
    let body = '';
    for await (const chunk of request) body += chunk;
    payloads.push(JSON.parse(body));
    if (calls === 1) respond(response);
    else { response.writeHead(200); response.end('{}'); }
  });
  store.ingest(event(), NOW);
  const first = worker.tick();
  assert.equal(worker.tick(), first, 'only one tick may drain the outbox at a time');
  const response = await requestArrived;
  store.ingest(event('refund', 2), NOW + 1);
  response.writeHead(429, { 'retry-after': '60' });
  response.end();
  assert.equal(await first, 0);
  advance(59_000);
  assert.equal(await worker.tick(), 0);
  assert.equal(calls, 1);
  advance(1_001);
  assert.equal(await worker.tick(), 1);
  assert.equal(calls, 2);
  assert.ok(payloads[1].version > payloads[0].version);
  assert.equal(payloads[1].summary.netTickets, 3);
  assert.deepEqual(store.due(NOW + 60_002), []);
});

test('provider redirects cannot forward the CRM bearer token to another endpoint', async (t) => {
  let calls = 0;
  let trapReached = false;
  const { store, worker } = await setup(t, (request, response) => {
    calls += 1;
    if (request.url === '/credential-trap') trapReached = true;
    response.writeHead(302, { location: '/credential-trap' });
    response.end();
  });
  store.ingest(event(), NOW);
  assert.equal(await worker.tick(), 0);
  assert.equal(calls, 1);
  assert.equal(trapReached, false);
  assert.deepEqual(store.due(NOW + 1), []);
});

test('reconciliation accepts every identifier format the webhook accepts', async (t) => {
  const { store, worker } = await setup(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify([{ showId: 'show:2026.10', orders: 1, netTickets: 4, netCents: 10_000, currency: 'USD' }]));
  });
  store.ingest(event(), NOW);
  store.complete(store.due(NOW)[0], NOW + 1);
  assert.deepEqual(await worker.reconcile(), []);
  assert.deepEqual(store.due(NOW + 2), []);
});

test('malformed CRM snapshots cannot trigger destructive reconciliation work', async (t) => {
  const { store, worker } = await setup(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify([{ showId: 'show:2026.10', orders: 1, netTickets: -100, netCents: 0, currency: 'USD' }]));
  });
  store.ingest(event(), NOW);
  store.complete(store.due(NOW)[0], NOW + 1);
  await assert.rejects(worker.reconcile());
  assert.deepEqual(store.due(NOW + 2), []);
  assert.equal(store.summaries()[0].netTickets, 4);
});
