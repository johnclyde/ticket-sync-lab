/**
 * Small, plain-text Resend adapter. No retries or provider response bodies are logged.
 * The caller must persist an immutable payload and key before the first attempt.
 * Resend retains idempotency keys for 24 hours, so stop uncertain retries before
 * that window ends and reconcile manually instead of risking a second email.
 * https://resend.com/docs/api-reference/emails/send-email
 * https://resend.com/docs/dashboard/emails/idempotency-keys
 */
export const RESEND_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const RESPONSE_LIMIT = 16_384;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CONTROLS = /[\u0000-\u001f\u007f]/;

export class ResendError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly terminal: boolean;

  constructor(code: string, options: { status?: number; retryAfterMs?: number; terminal: boolean }) {
    super(code);
    this.name = 'ResendError';
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.terminal = options.terminal;
  }
}

export type ResendOptions = {
  apiKey: string;
  from: string;
  to: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type ResendMessage = { subject: string; text: string; idempotencyKey: string };

function invalid(field: string): never {
  throw new ResendError(`resend_invalid_${field}`, { terminal: true });
}

// Deliberately supports simple ASCII mailboxes, not quoted local parts or groups.
function mailbox(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 254 || CONTROLS.test(value)) invalid(field);
  const match = /^([A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+)@([A-Za-z0-9.-]+)$/.exec(value);
  if (!match || match[1].length > 64 || match[1].startsWith('.') || match[1].endsWith('.') || match[1].includes('..')) invalid(field);
  const labels = match[2].split('.');
  if (labels.length < 2 || labels.some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) invalid(field);
  return value;
}

function sender(value: unknown): string {
  if (typeof value !== 'string' || value.length > 380 || CONTROLS.test(value)) invalid('from');
  if (!value.includes('<')) return mailbox(value, 'from');
  const match = /^([^<>"(),;:]{1,100}) <([^<>]+)>$/.exec(value);
  if (!match || match[1].trim() !== match[1]) invalid('from');
  mailbox(match[2], 'from');
  return value;
}

function recipients(value: unknown, field: string): string[] {
  const values = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(values) || values.length === 0 || values.length > 50) invalid(field);
  return values.map((item) => mailbox(item, field));
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : undefined;
  const date = seconds === undefined ? Date.parse(value) : NaN;
  const milliseconds = seconds === undefined ? date - Date.now() : seconds * 1_000;
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? Math.min(Math.ceil(milliseconds), RESEND_IDEMPOTENCY_WINDOW_MS)
    : undefined;
}

async function readResponse(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > RESPONSE_LIMIT) {
    await response.body?.cancel();
    throw new ResendError('resend_response_too_large', { terminal: false });
  }
  if (!response.body) throw new ResendError('resend_invalid_response', { terminal: false });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new ResendError('resend_response_too_large', { terminal: false });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ResendError('resend_invalid_response', { terminal: false });
  }
}

export class ResendMailer {
  #apiKey: string;
  #envelope: { from: string; to: string[]; bcc?: string[]; reply_to?: string };
  #fetch: typeof fetch;
  #timeoutMs: number;

  constructor(options: ResendOptions) {
    if (typeof options.apiKey !== 'string' || !/^re_[A-Za-z0-9_-]{8,256}$/.test(options.apiKey)) invalid('api_key');
    this.#apiKey = options.apiKey;
    this.#envelope = { from: sender(options.from), to: recipients(options.to, 'to') };
    if (options.bcc !== undefined) this.#envelope.bcc = recipients(options.bcc, 'bcc');
    if (this.#envelope.to.length + (this.#envelope.bcc?.length ?? 0) > 50) invalid('recipient_count');
    if (options.replyTo !== undefined) this.#envelope.reply_to = mailbox(options.replyTo, 'reply_to');
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 120_000) invalid('timeout');
  }

  async send(message: ResendMessage): Promise<{ id: string }> {
    if (typeof message.subject !== 'string' || message.subject.trim().length === 0 || message.subject.length > 256 || CONTROLS.test(message.subject)) invalid('subject');
    if (typeof message.text !== 'string' || message.text.trim().length === 0 || Buffer.byteLength(message.text) > 65_536 || message.text.includes('\0')) invalid('text');
    if (typeof message.idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(message.idempotencyKey)) invalid('idempotency_key');
    const body = JSON.stringify({ ...this.#envelope, subject: message.subject, text: message.text });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch('https://api.resend.com/emails', {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': message.idempotencyKey,
        },
        body,
      });
      if (!response.ok) {
        const retryAfterMs = retryAfter(response.headers.get('retry-after'));
        await response.body?.cancel();
        throw new ResendError(`resend_http_${response.status}`, {
          status: response.status, retryAfterMs,
          terminal: response.status !== 408 && response.status !== 429 && response.status < 500,
        });
      }
      const result = await readResponse(response);
      if (!result || typeof result !== 'object' || !('id' in result) || typeof result.id !== 'string' || !UUID.test(result.id)) {
        throw new ResendError('resend_invalid_response', { terminal: false });
      }
      return { id: result.id };
    } catch (error) {
      if (error instanceof ResendError) throw error;
      throw new ResendError(controller.signal.aborted ? 'resend_timeout' : 'resend_transport_error', { terminal: false });
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
