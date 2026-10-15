import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Delivery, Summary } from './domain.ts';

// A deliberately synthetic destination contract, not a HubSpot/Salesforce emulator.
export class MockCrm {
  server: Server;
  private token: string;
  private rows = new Map<string, { version: number; summary: Summary }>();
  private seen = new Map<string, string>();
  failures: Array<{ status: number; retryAfter?: string; afterCommit?: boolean }> = [];
  attempts: string[] = [];
  writes = 0;

  constructor(token: string) {
    this.token = token;
    this.server = createServer(async (request, response) => {
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (request.headers.authorization !== `Bearer ${this.token}`) return json(401, { error: 'unauthorized' });
      if (request.method === 'GET' && request.url === '/shows') return json(200, this.summaries());
      if (request.method !== 'POST' || request.url !== '/projections') return json(404, {});
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65_536) return json(413, {});
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      let delivery: Delivery;
      try { delivery = JSON.parse(body); } catch { return json(400, {}); }
      const key = request.headers['idempotency-key'];
      if (!delivery?.summary || !Number.isSafeInteger(delivery.version) || delivery.version < 1
        || typeof delivery.showId !== 'string' || typeof key !== 'string'
        || key !== `${delivery.showId}:${delivery.version}` || delivery.summary.showId !== delivery.showId) return json(400, {});
      this.attempts.push(key);
      const fingerprint = body;
      const existing = this.seen.get(key);
      if (existing) return json(existing === fingerprint ? 200 : 409, { duplicate: true });
      const failure = this.failures.shift();
      if (failure && !failure.afterCommit) {
        if (failure.retryAfter) response.setHeader('retry-after', failure.retryAfter);
        return json(failure.status, { error: 'injected_failure' });
      }
      const previous = this.rows.get(delivery.showId);
      if (previous && previous.version >= delivery.version) return json(409, { error: 'old_projection' });
      this.rows.set(delivery.showId, { version: delivery.version, summary: structuredClone(delivery.summary) });
      this.seen.set(key, fingerprint);
      this.writes++;
      if (failure?.afterCommit) { request.socket.destroy(); return; }
      json(200, { ok: true });
    });
  }

  summaries(): Summary[] { return [...this.rows.values()].map(row => structuredClone(row.summary)); }
  drift(showId: string, netTickets: number): void {
    const row = this.rows.get(showId);
    if (!row) throw new Error('Unknown synthetic show');
    row.summary.netTickets = netTickets;
  }
  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async close(): Promise<void> { await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve())); }
}
