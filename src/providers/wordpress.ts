import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type FeedItem = {
  sourceId: string;
  title: string;
  url: string;
  publishedAt: string;
  modifiedAt: string;
};

export type WordPressFeedErrorCode =
  | 'invalid_config' | 'unsafe_address' | 'network' | 'timeout'
  | 'http' | 'rate_limited' | 'response_too_large' | 'invalid_json'
  | 'invalid_page' | 'schema' | 'pagination' | 'page_limit';

export class WordPressFeedError extends Error {
  readonly code: WordPressFeedErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: WordPressFeedErrorCode, message: string, details: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'WordPressFeedError';
    this.code = code;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }
}

export type WordPressFeedOptions = {
  /** A trusted deployment setting containing the complete public posts endpoint, not user input. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Deadline for each complete response, including its body. Default: 15 seconds. */
  timeoutMs?: number;
  /** Maximum whole-feed pages; exceeding this rejects the snapshot. Default: 10. */
  maxPages?: number;
  /** Only for a local fixture server. Never enables arbitrary private networks. */
  allowLoopbackForTests?: boolean;
};

const PAGE_SIZE = 100;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const FIELDS = 'id,link,title,date_gmt,modified_gmt';

function fail(code: WordPressFeedErrorCode, message: string): never {
  throw new WordPressFeedError(code, message);
}

function loopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

function publicHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  // IP literals are deliberately unsupported, including public IPs.
  return !isIP(name.replace(/^\[|\]$/g, '')) && name.includes('.')
    && !/(^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(name)
    && /^[a-z0-9.-]+$/.test(name);
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127)
      || (a === 198 && (b === 18 || b === 19)));
  }
  // Global unicast only. This also excludes IPv4-mapped and local IPv6 addresses.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address)
    && !address.toLowerCase().startsWith('2001:db8:');
}

function validatedUrl(raw: unknown, allowLoopback: boolean, configuration: boolean): URL {
  const code = configuration ? 'invalid_config' : 'schema';
  if (typeof raw !== 'string' || raw.length > 4096) fail(code, 'Expected a bounded public URL');
  let url: URL;
  try { url = new URL(raw); } catch { return fail(code, 'Invalid public URL'); }
  const localFixture = allowLoopback && loopback(url.hostname);
  if ((url.protocol !== 'https:' && !(localFixture && url.protocol === 'http:'))
    || (!localFixture && !publicHost(url.hostname)) || url.username || url.password
    || (configuration && (url.search || url.hash))) {
    fail(code, 'URL must use a public HTTPS host without credentials');
  }
  return url;
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('schema', 'Expected an object in the WordPress feed');
  return input as Record<string, unknown>;
}

function utc(input: unknown): string {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z)?$/.test(input)) {
    fail('schema', 'WordPress GMT timestamps must be UTC datetimes');
  }
  const normalized = input.replace(/Z$/, '') + '.000Z';
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== normalized) {
    fail('schema', 'WordPress GMT timestamp is not a calendar datetime');
  }
  return normalized;
}

function plainTitle(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2000) fail('schema', 'WordPress title must be a bounded string');
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  const decoded = input.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? match;
    const point = entity.toLowerCase().startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '\uFFFD';
  });
  // This is plain display text, never HTML. Consumers still must escape it for their output context.
  return decoded.replace(/<!--[^]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function item(input: unknown, allowLoopback: boolean): FeedItem {
  const value = record(input);
  if (!Number.isSafeInteger(value.id) || (value.id as number) <= 0) fail('schema', 'WordPress post ID must be a positive integer');
  return {
    sourceId: String(value.id),
    title: plainTitle(record(value.title).rendered),
    url: validatedUrl(value.link, allowLoopback, false).href,
    publishedAt: utc(value.date_gmt),
    modifiedAt: utc(value.modified_gmt),
  };
}

function count(headers: Headers, name: string): number {
  const raw = headers.get(name);
  if (raw === null || !/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    fail('pagination', `Missing or invalid ${name} header`);
  }
  return Number(raw);
}

function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) {
    const milliseconds = Number(value) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

async function jsonBody(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    fail('response_too_large', 'WordPress response exceeds the byte limit');
  }
  const reader = response.body?.getReader();
  if (!reader) fail('invalid_json', 'WordPress response body is missing');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail('response_too_large', 'WordPress response exceeds the byte limit');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return fail('invalid_json', 'WordPress response is not valid JSON'); }
}

export class WordPressFeed {
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxPages: number;
  readonly #allowLoopback: boolean;
  readonly #checkDns: boolean;

  constructor(options: WordPressFeedOptions) {
    this.#allowLoopback = options.allowLoopbackForTests ?? false;
    this.#baseUrl = validatedUrl(options.baseUrl, this.#allowLoopback, true);
    this.#fetch = options.fetchImpl ?? fetch;
    this.#checkDns = !options.fetchImpl && !loopback(this.#baseUrl.hostname);
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxPages = options.maxPages ?? 10;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 120_000
      || !Number.isSafeInteger(this.#maxPages) || this.#maxPages < 1 || this.#maxPages > 100) {
      fail('invalid_config', 'Invalid WordPress timeout or page bound');
    }
  }

  async #page(page: number): Promise<{ data: unknown; total: number; pages: number }> {
    const url = new URL(this.#baseUrl);
    url.search = new URLSearchParams({ _fields: FIELDS, per_page: String(PAGE_SIZE), page: String(page), orderby: 'id', order: 'asc' }).toString();
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new WordPressFeedError('timeout', 'WordPress request timed out'));
      }, this.#timeoutMs);
    });
    const request = async () => {
      // The configured endpoint is trusted. DNS checking blocks accidental private resolutions;
      // it is not a sandbox for attacker-controlled hostnames or DNS rebinding.
      if (this.#checkDns) {
        const addresses = await lookup(url.hostname, { all: true });
        if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
          fail('unsafe_address', 'WordPress host resolved to a non-public address');
        }
      }
      const response = await this.#fetch(url, {
        method: 'GET', headers: { accept: 'application/json' },
        credentials: 'omit', redirect: 'error', signal: abort.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new WordPressFeedError(response.status === 429 ? 'rate_limited' : 'http', 'WordPress returned an unsuccessful HTTP status', {
          status: response.status, retryAfterMs: retryAfter(response.headers.get('retry-after')),
        });
      }
      if (response.redirected) {
        await response.body?.cancel();
        fail('http', 'WordPress redirects are not allowed');
      }
      const total = count(response.headers, 'x-wp-total');
      const pages = count(response.headers, 'x-wp-totalpages');
      if (pages !== Math.ceil(total / PAGE_SIZE)) {
        await response.body?.cancel();
        fail('pagination', 'WordPress pagination totals disagree');
      }
      if (pages > this.#maxPages) {
        await response.body?.cancel();
        fail('page_limit', 'Complete WordPress snapshot exceeds the configured page bound');
      }
      return { data: await jsonBody(response), total, pages };
    };
    try { return await Promise.race([request(), deadline]); }
    catch (error) {
      if (error instanceof WordPressFeedError) throw error;
      if (abort.signal.aborted) fail('timeout', 'WordPress request timed out');
      return fail('network', 'WordPress request failed');
    } finally {
      clearTimeout(timer!);
      // Header validation can fail before the body is read. Release that request too.
      abort.abort();
    }
  }

  async read(): Promise<FeedItem[]> {
    const output: FeedItem[] = [];
    let expectedTotal: number | undefined;
    let expectedPages = 1;
    let lastId = 0;
    for (let page = 1; page <= expectedPages; page++) {
      const response = await this.#page(page);
      if (expectedTotal === undefined) {
        expectedTotal = response.total;
        expectedPages = response.pages;
      } else if (response.total !== expectedTotal || response.pages !== expectedPages) {
        fail('pagination', 'WordPress collection changed during pagination; retry the full snapshot');
      }
      if (!Array.isArray(response.data)) fail('invalid_page', 'WordPress page must be an array');
      const expectedLength = Math.min(PAGE_SIZE, expectedTotal - (page - 1) * PAGE_SIZE);
      if (response.data.length !== expectedLength) fail('pagination', 'WordPress page is incomplete or overfull');
      for (const raw of response.data) {
        const normalized = item(raw, this.#allowLoopback);
        const id = Number(normalized.sourceId);
        if (id <= lastId) fail('pagination', 'WordPress IDs must increase without duplicates across all pages');
        lastId = id;
        output.push(normalized);
      }
    }
    return output;
  }
}
