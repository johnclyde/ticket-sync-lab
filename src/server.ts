import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IntegrationStore } from './store.ts';
import { DeliveryWorker } from './worker.ts';
import { IDENTIFIER } from './domain.ts';

type ServerOptions = { webhookSecret: string; adminToken: string; clock?: () => number };
const MAX_BODY = 65_536;

export function sign(body: string, secret: string, timestamp: string): string {
  return createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
}

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createIntegrationServer(store: IntegrationStore, worker: DeliveryWorker, options: ServerOptions) {
  if (options.webhookSecret.length < 32 || options.adminToken.length < 32) throw new Error('Use independent secrets of at least 32 characters');
  if (options.webhookSecret === options.adminToken) throw new Error('Use separate webhook and admin secrets');
  const now = options.clock ?? Date.now;
  const server = createServer(async (request, response) => {
    const path = request.url?.split('?')[0];
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    try {
      if (request.method === 'GET' && path === '/healthz') {
        const health = store.health(now()) as { healthy: boolean };
        return json(health.healthy && !worker.lastError ? 200 : 503, { ...health, workerError: worker.lastError });
      }
      if (request.method === 'POST' && path === '/webhooks/tickets') {
        if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(415, { error: 'json_required' });
        const timestamp = request.headers['x-ticket-timestamp'];
        const signature = request.headers['x-ticket-signature'];
        if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp)
          || Math.abs(now() - Number(timestamp) * 1000) > 300_000
          || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return json(401, { error: 'invalid_signature' });
        const body = await readBody(request, response);
        if (body === null) return;
        if (!equal(signature, sign(body, options.webhookSecret, timestamp))) return json(401, { error: 'invalid_signature' });
        let payload: unknown;
        try { payload = JSON.parse(body); } catch { return json(400, { error: 'invalid_json' }); }
        const result = store.ingest(payload, now());
        return json(result.status === 'quarantined' ? 422 : result.status === 'accepted' ? 202 : 200, result);
      }
      if (path === '/status' || path === '/admin/reconcile' || path === '/admin/retry') {
        if (!equal(String(request.headers.authorization ?? ''), `Bearer ${options.adminToken}`)) return json(401, { error: 'unauthorized' });
        if (request.method === 'GET' && path === '/status') return json(200, {
          operations: store.health(now()), summaries: store.summaries(), deliveries: store.deliveryStatus(),
          worker: { lastDeliveryAt: worker.lastDeliveryAt, lastReconciledAt: worker.lastReconciledAt, lastError: worker.lastError },
        });
        if (request.method === 'POST' && path === '/admin/reconcile') return json(200, { queued: await worker.reconcile() });
        if (request.method === 'POST' && path === '/admin/retry') {
          const text = await readBody(request, response);
          if (text === null) return;
          let body;
          try { body = JSON.parse(text); } catch { return json(400, { error: 'invalid_json' }); }
          if (!body || typeof body.showId !== 'string' || !IDENTIFIER.test(body.showId)) return json(400, { error: 'show_id_required' });
          return json(200, { queued: store.retryBlocked(body.showId, now()) });
        }
      }
      json(404, { error: 'not_found' });
    } catch {
      if (!response.headersSent) json(500, { error: 'operation_failed' });
      else response.end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5000;
  return server;
}

async function readBody(request: IncomingMessage, response: ServerResponse): Promise<string | null> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY) {
      response.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ error: 'body_too_large' }));
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { WEBHOOK_SECRET = '', ADMIN_TOKEN = '', CRM_URL = '', CRM_TOKEN = '' } = process.env;
  const dataPath = process.env.DATA_PATH ?? './data/tickets.sqlite';
  mkdirSync(dirname(dataPath), { recursive: true });
  const store = new IntegrationStore(dataPath);
  const worker = new DeliveryWorker(store, { url: CRM_URL, token: CRM_TOKEN });
  const server = createIntegrationServer(store, worker, { webhookSecret: WEBHOOK_SECRET, adminToken: ADMIN_TOKEN });
  const timer = setInterval(() => { worker.tick().catch(() => console.error('{"event":"worker_failed"}')); }, 1000);
  const reconciliation = setInterval(() => {
    worker.reconcile().catch(() => console.error('{"event":"reconciliation_failed"}'));
  }, 60_000);
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(JSON.stringify({ event: 'listening', port })));
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    clearInterval(timer); clearInterval(reconciliation);
    server.close(async () => { await worker.settle(); store.close(); });
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
