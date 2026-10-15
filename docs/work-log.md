# Work log

## 2026-10-15: first runnable version

- Built original synthetic ticketing and CRM contracts with TypeScript and SQLite.
- Added signed HTTP ingestion, cumulative refund accounting, persistent delivery state, bounded retries, and destination reconciliation.
- Reproduced a process restart, a changed source schema, CRM downtime/rate limits, and a lost acknowledgement after commit.
- Independent tests caught incoming snapshots resetting `Retry-After`, a late failure bypassing backoff for a newer version, and inconsistent identifier validation between ingestion and reconciliation. These are covered by regression tests.
- Added authenticated inspection and explicit retry of blocked deliveries.
- No private customer source, credentials, or data are included.
- Validation: TypeScript check passed; 43 core/HTTP tests passed; all six executable demonstration scenarios passed on Node 24.19.0. The local Docker daemon was unavailable, so the container recipe has not been exercised here.

## Next increments

1. Choose one real provider pair and implement its documented contracts in a sandbox account.
2. Add source-side polling/reconciliation with a cursor and heartbeat so missed webhooks and quiet periods are distinguishable.
3. Select durable hosted state and worker coordination before enabling multiple instances.
4. Wire the operational signals to a real alert destination and exercise recovery.

This log is the repository's work record. GitHub Issues are not used.

## 2026-10-15: real providers and durable feed notifications

Added an original WordPress REST reader and a Resend email adapter. A separate feed runner validates complete paginated metadata snapshots, establishes a silent baseline, commits bounded change digests atomically, and retains delivery state across restarts. Provider-wide cooldowns prevent newly queued mail from bypassing a rate limit. Retries preserve the payload and key and stop after eight attempts or 23 hours from the first attempt.

Added observation, once, watch, and status commands. Observation mode requires no account and sends no email. Source and mail-envelope changes require a separate database. Added a live-feed operations guide. No production application source was copied into this repository.

Verification: 92 tests passed, type checking passed, and all six ticketing recovery scenarios passed. The live WordPress command fetched and saved a healthy baseline of 1,110 posts at 2026-10-15 08:35 UTC. Resend was verified with offline contract tests; no live notification was sent. Review caught and fixed atomic cooldown persistence, large UTF-8 digest bounds, and early-response cleanup.

GitHub-hosted checks remain subject to the previously observed account billing lock; these results are local. No new infrastructure was provisioned or existing production service changed. The previously noted Docker daemon limitation remains.
