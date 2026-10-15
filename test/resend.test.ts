import assert from 'node:assert/strict';
import test from 'node:test';
import { ResendError, ResendMailer, RESEND_IDEMPOTENCY_WINDOW_MS } from '../src/providers/resend.ts';

const ID = '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794';
const OPTIONS = { apiKey: 're_synthetic_test_key', from: 'Feed Watch <feed@example.com>', to: 'reader@example.com' };
const MESSAGE = { subject: 'Feed changed', text: 'One new public article.', idempotencyKey: 'feed/source/digest-1' };
function fake(fn: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input, init) => fn(input, init)) as typeof fetch;
}
function success(): Response { return Response.json({ id: ID }); }
function isError(code: string, terminal: boolean): (error: unknown) => boolean {
  return (error) => error instanceof ResendError && error.code === code && error.terminal === terminal;
}

test('Resend uses the official endpoint and stable plain-text payload with explicit envelope and key', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const mailer = new ResendMailer({
    ...OPTIONS, bcc: ['copy@example.com'], replyTo: 'replies@example.com',
    fetchImpl: fake((input, init) => { calls.push({ url: String(input), init: init! }); return success(); }),
  });
  assert.deepEqual(await mailer.send(MESSAGE), { id: ID });
  await mailer.send(MESSAGE);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.method, 'POST');
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${OPTIONS.apiKey}`);
  assert.equal(headers.get('idempotency-key'), MESSAGE.idempotencyKey);
  assert.deepEqual(JSON.parse(calls[0].init.body as string), {
    from: OPTIONS.from, to: [OPTIONS.to], bcc: ['copy@example.com'], reply_to: 'replies@example.com',
    subject: MESSAGE.subject, text: MESSAGE.text,
  });
  assert.equal(calls[0].init.body, calls[1].init.body);
  assert.equal(JSON.stringify(mailer), '{}', 'configuration and API key are private');
});

test('Resend copies recipient arrays so later mutations cannot change a retried envelope', async () => {
  const recipients = ['reader@example.com'];
  const bcc = ['copy@example.com'];
  let body: Record<string, unknown> = {};
  const mailer = new ResendMailer({ ...OPTIONS, to: recipients, bcc, fetchImpl: fake((_, init) => { body = JSON.parse(init!.body as string); return success(); }) });
  recipients[0] = 'other@example.com'; bcc.push('other@example.com');
  await mailer.send(MESSAGE);
  assert.deepEqual(body.to, ['reader@example.com']);
  assert.deepEqual(body.bcc, ['copy@example.com']);
});

test('Resend rejects invalid envelopes and credentials without reflecting their values', () => {
  for (const [field, value] of [
    ['from', 'Sender\r\nBcc: leaked@example.com'], ['from', 'Name <invalid>'],
    ['from', 'Name <sender@example.com>, extra@example.com'], ['to', 'missing-at-sign'],
    ['to', 'a..b@example.com'], ['to', 'a@-bad.example'], ['to', []],
    ['bcc', ['valid@example.com', 'bad@example.com\n']], ['replyTo', 'Name <reply@example.com>'],
    ['apiKey', 're_secret\r\nheader'], ['timeoutMs', 0],
  ] as [string, unknown][]) {
    assert.throws(() => new ResendMailer({ ...OPTIONS, [field]: value }), (error: unknown) => {
      assert.ok(error instanceof ResendError);
      assert.equal(error.terminal, true);
      assert.ok(!error.message.includes('@'));
      return true;
    });
  }
  assert.throws(() => new ResendMailer({ ...OPTIONS, to: Array(50).fill('a@example.com'), bcc: 'b@example.com' }), isError('resend_invalid_recipient_count', true));
});

test('Resend validates message bounds and idempotency header before any request', async () => {
  let calls = 0;
  const mailer = new ResendMailer({ ...OPTIONS, fetchImpl: fake(() => { calls++; return success(); }) });
  for (const patch of [
    { subject: '' }, { subject: 'a'.repeat(257) }, { subject: 'hello\r\nBcc: other' },
    { text: ' ' }, { text: '\0' }, { text: '😀'.repeat(16_385) },
    { idempotencyKey: '' }, { idempotencyKey: 'a'.repeat(257) }, { idempotencyKey: 'bad\nkey' },
  ]) await assert.rejects(mailer.send({ ...MESSAGE, ...patch }), (error: unknown) => error instanceof ResendError && error.terminal);
  assert.equal(calls, 0);
});

test('Resend classifies retryable status codes and preserves numeric Retry-After', async () => {
  for (const status of [408, 429, 500, 503]) {
    let calls = 0;
    const mailer = new ResendMailer({ ...OPTIONS, fetchImpl: fake(() => {
      calls++; return new Response('sensitive provider response', { status, headers: { 'retry-after': '7' } });
    }) });
    await assert.rejects(mailer.send(MESSAGE), (error: unknown) => {
      assert.ok(error instanceof ResendError);
      assert.equal(error.code, `resend_http_${status}`);
      assert.equal(error.status, status); assert.equal(error.retryAfterMs, 7_000); assert.equal(error.terminal, false);
      assert.ok(!JSON.stringify(error).includes('sensitive'));
      return true;
    });
    assert.equal(calls, 1, 'retry timing belongs to durable caller');
  }
});

test('Resend stops permanent errors including conflicting or expired payload keys', async () => {
  for (const status of [301, 400, 401, 403, 404, 409, 422]) {
    const mailer = new ResendMailer({ ...OPTIONS, fetchImpl: fake(() => new Response('private details', { status })) });
    await assert.rejects(mailer.send(MESSAGE), isError(`resend_http_${status}`, true));
  }
});

test('Resend accepts HTTP-date Retry-After and caps it at the deduplication window', async () => {
  for (const [header, minimum, maximum] of [
    [new Date(Date.now() + 60_000).toUTCString(), 58_000, 60_000],
    ['999999999', RESEND_IDEMPOTENCY_WINDOW_MS, RESEND_IDEMPOTENCY_WINDOW_MS],
  ] as [string, number, number][]) {
    const mailer = new ResendMailer({ ...OPTIONS, fetchImpl: fake(() => new Response('', { status: 429, headers: { 'retry-after': header } })) });
    await assert.rejects(mailer.send(MESSAGE), (error: unknown) => {
      assert.ok(error instanceof ResendError);
      assert.ok(error.retryAfterMs! >= minimum && error.retryAfterMs! <= maximum);
      return true;
    });
  }
});

test('Resend handles an uncertain transport outcome without leaking exceptions', async () => {
  const mailer = new ResendMailer({ ...OPTIONS, fetchImpl: fake(() => { throw new Error(`connection failure ${OPTIONS.apiKey}`); }) });
  await assert.rejects(mailer.send(MESSAGE), isError('resend_transport_error', false));
});

test('Resend timeout aborts a stalled request', async () => {
  let signal: AbortSignal | undefined;
  const mailer = new ResendMailer({ ...OPTIONS, timeoutMs: 10, fetchImpl: fake((_, init) => {
    signal = init!.signal as AbortSignal;
    return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  }) });
  await assert.rejects(mailer.send(MESSAGE), isError('resend_timeout', false));
  assert.equal(signal!.aborted, true);
});

test('Resend treats malformed success responses as uncertain and safe to retry with the SAME key', async () => {
  for (const body of ['not json', '{}', 'null', '[]', '{"id":123}', '{"id":"private-provider-error"}']) {
    const mailer = new ResendMailer({ ...OPTIONS, fetchImpl: fake(() => new Response(body)) });
    await assert.rejects(mailer.send(MESSAGE), isError('resend_invalid_response', false));
  }
});

test('Resend bounds both declared and streamed response size', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(20_000)); },
      cancel() { cancelled = true; },
    });
    const mailer = new ResendMailer({ ...OPTIONS, fetchImpl: fake(() => new Response(stream, { headers: declared ? { 'content-length': '20000' } : {} })) });
    await assert.rejects(mailer.send(MESSAGE), isError('resend_response_too_large', false));
    assert.equal(cancelled, true);
  }
});
