import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { FeedRunner, FeedStore } from './feed.ts';
import { WordPressFeed } from './providers/wordpress.ts';
import { ResendMailer } from './providers/resend.ts';

async function main() {
  const mode = process.argv[2] ?? 'inspect';
  if (!['inspect', 'once', 'watch', 'status'].includes(mode)) throw new Error('usage_feed_inspect_once_watch_status');
  const baseUrl = process.env.WORDPRESS_POSTS_URL ?? 'https://wordpress.org/news/wp-json/wp/v2/posts';
  const reader = new WordPressFeed({ baseUrl, maxPages: Number(process.env.WORDPRESS_MAX_PAGES ?? 20) });
  if (mode === 'inspect') {
    const items = await reader.read();
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), count: items.length, sample: items.slice(-3) }, null, 2));
    return;
  }
  const intervalMs = Number(process.env.FEED_POLL_SECONDS ?? 900) * 1000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 900_000 || intervalMs > 86_400_000) throw new Error('feed_poll_seconds_must_be_900_to_86400');
  const file = resolve(process.env.FEED_DB_PATH ?? 'data/wordpress.sqlite');
  const from = process.env.MAIL_FROM;
  const to = process.env.MAIL_TO;
  const bcc = process.env.MAIL_BCC;
  const replyTo = process.env.MAIL_REPLY_TO;
  const notificationEnabled = process.env.FEED_SEND_EMAIL === 'true';
  if (notificationEnabled && (!from || !to)) throw new Error('mail_from_and_to_required');
  const mailer = notificationEnabled && mode !== 'status' ? new ResendMailer({
    apiKey: process.env.RESEND_API_KEY ?? '', from: from!, to: to!, bcc, replyTo,
  }) : undefined;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Bind durable messages to their destination and source. Changing destinations
  // requires a new database, preventing old queued mail from being rerouted.
  const store = new FeedStore(file, { baseUrl, notificationEnabled, from, to, bcc, replyTo });
  chmodSync(file, 0o600);
  const runner = new FeedRunner(store, reader, mailer, { pollIntervalMs: intervalMs, notificationsEnabled: notificationEnabled });
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (mode === 'status') {
      const status = store.status(Date.now(), intervalMs * 3);
      console.log(JSON.stringify(status, null, 2));
      if (!status.healthy) process.exitCode = 1;
      return;
    }
    do {
      const status = await runner.run() as { healthy: boolean };
      console.log(JSON.stringify({ checkedAt: new Date().toISOString(), mode, notificationEnabled, ...status }));
      if (mode === 'once') { if (!status.healthy) process.exitCode = 1; break; }
      try { await sleep(60_000, undefined, { signal: abort.signal }); }
      catch { if (!abort.signal.aborted) throw new Error('feed_wait_failed'); }
    } while (!abort.signal.aborted);
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    store.close();
  }
}
main().catch(() => { console.error('Feed command failed. Check configuration and the documented prerequisites.'); process.exitCode = 1; });
