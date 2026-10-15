import { IDENTIFIER, type Summary } from './domain.ts';
import type { IntegrationStore } from './store.ts';

type WorkerOptions = { url: string; token: string; clock?: () => number; timeoutMs?: number };

export class DeliveryWorker {
  private store: IntegrationStore;
  private options: WorkerOptions;
  private running: Promise<number> | undefined;
  private reconciling: Promise<string[]> | undefined;
  lastDeliveryAt: number | null = null;
  lastReconciledAt: number | null = null;
  lastError: string | null = null;

  constructor(store: IntegrationStore, options: WorkerOptions) {
    const url = new URL(options.url);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
      throw new Error('CRM URL must use HTTPS, or HTTP on loopback for the local demo');
    }
    if (!options.token) throw new Error('CRM token is required');
    this.store = store;
    this.options = { ...options, url: options.url.replace(/\/$/, '') };
  }

  private now(): number { return this.options.clock?.() ?? Date.now(); }

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(this.options.url + path, {
      ...init,
      redirect: 'error',
      headers: { ...init.headers, authorization: `Bearer ${this.options.token}` },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
    });
  }

  tick(): Promise<number> {
    if (this.running) return this.running;
    this.running = this.deliver().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async deliver(): Promise<number> {
    let completed = 0;
    for (const delivery of this.store.due(this.now())) {
      try {
        const response = await this.request('/projections', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `${delivery.showId}:${delivery.version}`,
          },
          body: JSON.stringify({ showId: delivery.showId, version: delivery.version, summary: delivery.summary }),
        });
        // Error bodies may contain provider/customer data. Persist only the status.
        await response.body?.cancel();
        if (response.ok) {
          this.store.complete(delivery, this.now());
          this.lastDeliveryAt = this.now();
          this.lastError = null;
          completed++;
        } else {
          const temporary = response.status === 408 || response.status === 429 || response.status >= 500;
          const error = `crm_http_${response.status}`;
          this.store.fail(delivery, this.now(), error, retryAfter(response.headers.get('retry-after'), this.now()), !temporary);
          this.lastError = error;
        }
      } catch {
        this.store.fail(delivery, this.now(), 'crm_transport_error');
        this.lastError = 'crm_transport_error';
      }
    }
    return completed;
  }

  reconcile(): Promise<string[]> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.readAndReconcile().finally(() => { this.reconciling = undefined; });
    return this.reconciling;
  }

  async settle(): Promise<void> {
    await Promise.allSettled([this.running, this.reconciling]);
  }

  private async readAndReconcile(): Promise<string[]> {
    try {
      const response = await this.request('/shows');
      if (!response.ok) { await response.body?.cancel(); throw new Error('CRM snapshot unavailable'); }
      const text = await boundedResponse(response, 1_048_576);
      const data: unknown = JSON.parse(text);
      if (!Array.isArray(data) || data.length > 10_000 || !data.every(isSummary)) throw new Error('Invalid CRM snapshot');
      if (new Set(data.map(row => row.showId)).size !== data.length) throw new Error('Duplicate CRM show identifiers');
      const repaired = this.store.reconcile(data, this.now());
      this.lastReconciledAt = this.now();
      this.lastError = null;
      return repaired;
    } catch {
      this.lastError = 'crm_reconciliation_failed';
      throw new Error(this.lastError);
    }
  }
}

function isSummary(value: unknown): value is Summary {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.showId === 'string' && IDENTIFIER.test(row.showId)
    && row.currency === 'USD'
    && ['orders', 'netTickets', 'netCents'].every(key => Number.isSafeInteger(row[key]) && Number(row[key]) >= 0);
}

async function boundedResponse(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new Error('Empty CRM snapshot');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('CRM snapshot too large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}

export function retryAfter(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : NaN;
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}
