# Live WordPress feed and Resend delivery

This second integration reads a real WordPress REST endpoint and can send change digests through Resend. It is separate from the synthetic ticketing exercise. It uses original code, public post metadata, and no customer records.

## Read a real feed

With Node 24, without credentials:

```sh
npm run feed -- inspect
npm run feed -- once
npm run feed -- status
```

The default source is WordPress News. The first command fetches all pages and prints a count and three metadata records. The second records a baseline in `data/wordpress.sqlite`. The third returns an aggregate status and a nonzero exit code when unhealthy. The first successful snapshot sends no email. Observation mode continues updating the baseline without creating delivery jobs.

On October 15, 2026 the adapter successfully read 1,110 public posts across 12 pages. Only IDs, titles, links, publication dates, and modification dates are requested. Article bodies are not downloaded. This is a live API check, not a claim that this new service has been deployed in production.

## Enable change digests

Use your own verified sending domain and authorized recipient. Supply the API key through your secret manager or process environment. Do not put it in a shell history, repository, or issue.

```sh
export WORDPRESS_POSTS_URL='https://wordpress.org/news/wp-json/wp/v2/posts'
export WORDPRESS_MAX_PAGES=20
export FEED_DB_PATH='./data/wordpress-mail.sqlite'
export FEED_SEND_EMAIL=true
export MAIL_FROM='Feed Watch <updates@your-verified-domain.com>'
export MAIL_TO='you@your-domain.com'
# RESEND_API_KEY must already be present in the environment.
npm run feed -- watch
```

Optional `MAIL_BCC` and `MAIL_REPLY_TO` each accept one mailbox. `MAIL_TO` also accepts one mailbox in the CLI. `FEED_POLL_SECONDS` defaults to 900 and must be between 900 and 86400. The daemon checks delivery work once per minute and fetches the source only when the persisted poll deadline permits it.

The database is bound to the feed URL, notification mode, sender, recipients, and reply address. Use a separate database when changing these settings so previously queued messages cannot go to a new recipient. Rotating an API key does not change the binding. Run `status` with the same configuration as `watch`; it does not need the API key.

Each complete snapshot is compared with the saved metadata. Adds, edits, and removals create a bounded plain-text digest. A single SQLite transaction commits the new snapshot and immutable delivery job. The initial baseline is deliberately silent. Notification mode is opt-in and requires explicit sender/recipient configuration.

## Failure behavior

- Validate every page before advancing the saved snapshot. Bad dates, missing fields, duplicate IDs, changed pagination totals, and truncated pagination reject the entire poll. Additive vendor fields are allowed.
- Use a maximum page count and a 1 MiB response limit per page. A response timeout covers headers and body. Redirects are rejected.
- Keep the endpoint in trusted deployment configuration. Public-host/DNS checks catch accidental private targets; this is not a general URL-fetching service or a DNS-rebinding sandbox.
- Persist the exact digest and idempotency key before sending. The same bytes and envelope are used after a restart or ambiguous response.
- Retry transport errors, HTTP 408, 429, and server errors with exponential backoff and `Retry-After`. Provider cooldown is persisted across all queued digests, including newly created jobs.
- Block permanent errors and exhausted retry budgets. A maximum of eight attempts is allowed. Resend retains idempotency keys for 24 hours; this worker stops replay after 23 hours from the first attempt. It never automatically makes a fresh key for an uncertain message. Inspect provider delivery history before any manual recovery.
- Surface poll errors, stale successful polls, pending jobs, and blocked deliveries through `status`. Freshness means time since a successful complete poll, so an unchanged feed remains healthy.

WordPress pagination is not a transactional snapshot. The checks catch common movement between pages but cannot prove point-in-time consistency during concurrent edits. This example assumes a modest feed and conservatively rejects unstable pagination. Resend acceptance returns a message ID; it does not prove inbox delivery. There is no delivery-webhook receiver in this example.

## Operations and verification

Run one worker process per database on persistent storage. Do not run overlapping scheduled jobs or multiple replicas. The `watch` process handles graceful shutdown; supervise it with your host's service manager. Monitor the exit status of `status` from an independent system. A process that has stopped cannot alert on its own failure.

No new cloud resources or paid accounts are provisioned by this project. The repository does not include a configured external alert receiver, retention policy, database migrations, or backup automation. The Resend adapter is tested with contract fixtures; no live email was sent as part of its initial verification.

```sh
npm run check
npm test
npm run feed -- inspect
```

Offline tests cover full-feed validation, response limits, rate limits, stable delivery requests, crash recovery, and the retry cutoff. These tests use injected clocks and providers. Live WordPress access is deliberately separate from CI.

## Provider documentation

- [WordPress posts API](https://developer.wordpress.org/rest-api/reference/posts/)
- [WordPress pagination](https://developer.wordpress.org/rest-api/using-the-rest-api/pagination/)
- [Resend send email](https://resend.com/docs/api-reference/emails/send-email)
- [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys)
- [Resend errors](https://resend.com/docs/api-reference/errors)
