import assert from 'node:assert/strict';
import test from 'node:test';
import { WordPressFeed, WordPressFeedError } from '../src/providers/wordpress.ts';

const BASE = 'https://wordpress.org/news/wp-json/wp/v2/posts';

function post(id = 1, changes: Record<string, unknown> = {}) {
  return {
    id, link: `https://wordpress.org/news/post-${id}/`,
    title: { rendered: `Post ${id}` },
    date_gmt: '2026-10-15T09:30:00', modified_gmt: '2026-10-15T10:00:00',
    ...changes,
  };
}

function response(body: unknown, total = 1, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { headers: {
    'content-type': 'application/json', 'x-wp-total': String(total),
    'x-wp-totalpages': String(Math.ceil(total / 100)), ...headers,
  } });
}

function errorCode(code: string) {
  return (error: unknown) => error instanceof WordPressFeedError && error.code === code;
}

function reader(body: unknown, total = 1, headers: Record<string, string> = {}) {
  return new WordPressFeed({ baseUrl: BASE, fetchImpl: async () => response(body, total, headers) });
}

test('WordPress metadata becomes UTC plain text while additive provider fields remain compatible', async () => {
  const result = await reader([post(42, {
    title: { rendered: 'A <em>safe</em> title &#8217; &amp; more', protected: false, future_property: true },
    slug: 'ignored', content: { rendered: 'Article text is never retained' },
  })]).read();
  assert.deepEqual(result, [{
    sourceId: '42', title: 'A safe title ’ & more', url: 'https://wordpress.org/news/post-42/',
    publishedAt: '2026-10-15T09:30:00.000Z', modifiedAt: '2026-10-15T10:00:00.000Z',
  }]);
});

test('all pages are requested in ID order with bounded field selection and without credentials or redirects', async () => {
  const urls: URL[] = [];
  const feed = new WordPressFeed({ baseUrl: BASE, fetchImpl: async (input, init) => {
    const url = new URL(String(input));
    urls.push(url);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(init?.headers, { accept: 'application/json' });
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(url.searchParams.get('_fields'), 'id,link,title,date_gmt,modified_gmt');
    assert.equal(url.searchParams.get('per_page'), '100');
    assert.equal(url.searchParams.get('orderby'), 'id');
    assert.equal(url.searchParams.get('order'), 'asc');
    return response(url.searchParams.get('page') === '1'
      ? Array.from({ length: 100 }, (_, i) => post(i + 1)) : [post(101)], 101);
  } });
  const items = await feed.read();
  assert.equal(items.length, 101);
  assert.deepEqual(urls.map((url) => url.searchParams.get('page')), ['1', '2']);
});

test('a later page failure rejects the full snapshot without returning page one', async () => {
  let calls = 0;
  const feed = new WordPressFeed({ baseUrl: BASE, fetchImpl: async () => {
    calls++;
    return calls === 1 ? response(Array.from({ length: 100 }, (_, i) => post(i + 1)), 101)
      : new Response('sensitive upstream diagnostic', { status: 503 });
  } });
  await assert.rejects(feed.read(), (error: unknown) => {
    assert.ok(error instanceof WordPressFeedError);
    assert.equal(error.code, 'http');
    assert.equal(error.status, 503);
    assert.ok(!error.message.includes('sensitive'));
    return true;
  });
  assert.equal(calls, 2);
});

test('an empty collection is a valid complete snapshot', async () => {
  assert.deepEqual(await reader([], 0).read(), []);
});

test('a provider type change rejects the page while unknown additive fields are ignored', async () => {
  for (const changed of [
    { id: '1' }, { id: -1 }, { id: 0.5 }, { title: 'renamed shape' },
    { title: { rendered: 42 } }, { title: { rendered: 'x'.repeat(2001) } },
    { date_gmt: null }, { date_gmt: '2026-02-30T12:00:00' },
    { date_gmt: '2026-10-15T09:30:00-07:00' }, { modified_gmt: 'yesterday' },
    { link: 'http://wordpress.org/post' }, { link: 'https://user:secret@wordpress.org/post' },
    { link: 'https://127.0.0.1/post' },
  ]) {
    await assert.rejects(reader([post(1, changed)]).read(), errorCode('schema'));
  }
});

test('UTC dates with explicit Z are accepted and display markup is removed', async () => {
  const [item] = await reader([post(1, {
    date_gmt: '2024-02-29T12:00:00Z',
    title: { rendered: '<!-- hidden --><script>alert(1)</script>Math &lt;em&gt;news&lt;/em&gt; &quot;today&quot;' },
  })]).read();
  assert.equal(item.publishedAt, '2024-02-29T12:00:00.000Z');
  assert.equal(item.title, 'Math news "today"');
});

test('missing, malformed, or inconsistent totals fail rather than silently truncating a feed', async () => {
  const variants: Record<string, string>[] = [
    { 'x-wp-totalpages': '' }, { 'x-wp-totalpages': '-1' },
    { 'x-wp-totalpages': '1.5' }, { 'x-wp-totalpages': '2' },
    { 'x-wp-total': 'not a number' },
  ];
  for (const headers of variants) {
    await assert.rejects(reader([post()], 1, headers).read(), errorCode('pagination'));
  }
  await assert.rejects(new WordPressFeed({ baseUrl: BASE, fetchImpl: async () => new Response('[]') }).read(), errorCode('pagination'));
  await assert.rejects(reader([], 1).read(), errorCode('pagination'));
  await assert.rejects(reader([post()], 101).read(), errorCode('pagination'));
});

test('pagination-header failure aborts the request before leaving an unread body', async () => {
  let signal: AbortSignal | null | undefined;
  const feed = new WordPressFeed({ baseUrl: BASE, fetchImpl: async (_input, init) => {
    signal = init?.signal;
    return new Response('[]');
  } });
  await assert.rejects(feed.read(), errorCode('pagination'));
  assert.equal(signal?.aborted, true);
});

test('a collection larger than the configured bound fails before processing any data', async () => {
  let cancelled = false;
  const feed = new WordPressFeed({ baseUrl: BASE, fetchImpl: async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { 'x-wp-total': '1110', 'x-wp-totalpages': '12' } }) });
  await assert.rejects(feed.read(), errorCode('page_limit'));
  assert.equal(cancelled, true);
});

test('stable totals and strictly increasing IDs detect page drift and duplicate IDs', async () => {
  for (const scenario of ['count-change', 'repeat-id', 'conflicting-id'] as const) {
    let calls = 0;
    const feed = new WordPressFeed({ baseUrl: BASE, fetchImpl: async () => {
      calls++;
      if (calls === 1) return response(Array.from({ length: 100 }, (_, i) => post(i + 1)), 101);
      if (scenario === 'count-change') return response([post(101), post(102)], 102);
      return response([post(100, scenario === 'conflicting-id' ? { title: { rendered: 'changed title' } } : {})], 101);
    } });
    await assert.rejects(feed.read(), errorCode('pagination'));
  }
  await assert.rejects(reader([post(2), post(1)], 2).read(), errorCode('pagination'));
});

test('rate-limit errors retain status and Retry-After without leaking the response body', async () => {
  const feed = new WordPressFeed({ baseUrl: BASE, fetchImpl: async () => new Response('secret', {
    status: 429, headers: { 'retry-after': '17' },
  }) });
  await assert.rejects(feed.read(), (error: unknown) => {
    assert.ok(error instanceof WordPressFeedError);
    assert.equal(error.code, 'rate_limited');
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 17_000);
    assert.ok(!error.message.includes('secret'));
    return true;
  });
});

test('malformed JSON and non-array responses fail predictably', async () => {
  const feed = new WordPressFeed({ baseUrl: BASE, fetchImpl: async () => new Response('{broken', {
    headers: { 'x-wp-total': '1', 'x-wp-totalpages': '1' },
  }) });
  await assert.rejects(feed.read(), errorCode('invalid_json'));
  await assert.rejects(reader({ error: 'wrong collection' }).read(), errorCode('invalid_page'));
});

test('both advertised and streamed body limits stop oversized responses', async () => {
  for (const advertised of [true, false]) {
    const feed = new WordPressFeed({ baseUrl: BASE, fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1), {
      headers: {
        'x-wp-total': '1', 'x-wp-totalpages': '1',
        ...(advertised ? { 'content-length': String(1024 * 1024 + 1) } : {}),
      },
    }) });
    await assert.rejects(feed.read(), errorCode('response_too_large'));
  }
});

test('timeout covers fetch and a stalled response body', async () => {
  for (const phase of ['fetch', 'body']) {
    let signal: AbortSignal | null | undefined;
    const feed = new WordPressFeed({ baseUrl: BASE, timeoutMs: 10, fetchImpl: async (_input, init) => {
      signal = init?.signal;
      if (phase === 'fetch') return await new Promise<Response>(() => {});
      return new Response(new ReadableStream(), { headers: { 'x-wp-total': '1', 'x-wp-totalpages': '1' } });
    } });
    await assert.rejects(feed.read(), errorCode('timeout'));
    assert.equal(signal?.aborted, true);
  }
});

test('network errors are redacted', async () => {
  const feed = new WordPressFeed({ baseUrl: BASE, fetchImpl: async () => { throw new Error('sensitive DNS details'); } });
  await assert.rejects(feed.read(), (error: unknown) => {
    assert.ok(error instanceof WordPressFeedError);
    assert.equal(error.code, 'network');
    assert.ok(!error.message.includes('sensitive'));
    return true;
  });
});

test('endpoint validation rejects credentials, redirects via query, private hosts, and unbounded options', () => {
  for (const baseUrl of [
    'http://wordpress.org/posts', 'https://user:secret@wordpress.org/posts',
    `${BASE}?redirect=https://example.org`, `${BASE}#fragment`,
    'https://127.0.0.1/posts', 'https://10.1.2.3/posts', 'https://[::1]/posts',
    'https://localhost/posts', 'https://metadata.google.internal/posts',
  ]) assert.throws(() => new WordPressFeed({ baseUrl }), errorCode('invalid_config'));
  for (const options of [{ maxPages: 0 }, { maxPages: 101 }, { timeoutMs: 0 }, { timeoutMs: Infinity }]) {
    assert.throws(() => new WordPressFeed({ baseUrl: BASE, ...options }), errorCode('invalid_config'));
  }
});

test('explicit loopback option enables only local fixture hosts', async () => {
  const feed = new WordPressFeed({ baseUrl: 'http://127.0.0.1:1234/posts', allowLoopbackForTests: true,
    fetchImpl: async () => response([post()]),
  });
  assert.equal((await feed.read()).length, 1);
  assert.throws(() => new WordPressFeed({ baseUrl: 'http://10.1.2.3/posts', allowLoopbackForTests: true }), errorCode('invalid_config'));
});
