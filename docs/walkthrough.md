# Feed change and recovery walkthrough

The exercise begins with one order for four tickets at $50 each. Schema v1 represents sold and refunded quantities as flat fields. Schema v2 nests them under `quantities` and moves money under `amounts`.

```json
{
  "schemaVersion": 2,
  "deliveryId": "delivery-2",
  "order": {
    "id": "order-a",
    "showId": "show-spring",
    "version": 2,
    "quantities": { "sold": 4, "refunded": 1 },
    "amounts": { "gross": 20000, "refunded": 5000, "currency": "USD" }
  }
}
```

Both adapters produce the same internal order model. The partial refund leaves three tickets and $150. A second order adds two tickets and $100. A late revision-one event cannot restore the refunded ticket.

This schema change is a **controlled test fixture**, not an anecdote about a past customer incident. Unexpected versions and added/missing fields stop at validation. Existing totals remain intact and quarantine counters reveal the problem. Adapting a real feed would require a captured, sanitized example, contract tests, an explicit mapping, and replay from the source. Rejected payloads are not retained in this demo's database.

## The difficult case: an unknown delivery outcome

The CRM can accept a write and lose the connection before the integration receives an acknowledgement. Treating that as a definitive failure and generating a new operation would risk duplicate effects.

Here the desired projection and its version remain durable until acknowledged. Retrying sends the same idempotency key. The mock CRM recognizes the key and returns success without applying it again. The demo asserts that its successful-write count does not increase.

Idempotency alone is not enough. If a refund arrives while a previous projection is in flight, the older response must not mark the refund delivered. Completion therefore compares the version it sent to the current queued version. Tests also check the converse: a late rate-limit response still delays newer pending work for that show.

## Recovery operations

Use the bearer-protected `/status` endpoint to inspect each show's `status`, `attempts`, `nextAttemptAt`, and `lastError`. Safe errors include `crm_http_401`, `crm_http_429`, and `crm_transport_error`; arbitrary exception text is hashed rather than persisted.

After fixing a stopped destination or credential, call `POST /admin/retry` with the affected `showId`. This explicitly resets its retry budget while retaining the same operation identity. Calling it on already-pending work does nothing. Restarting the process preserves blocked state.

`POST /admin/reconcile` reads the destination and compares known show totals with the local source of truth. Missing or corrupted destination totals receive a new projection version. Pending/backed-off/blocked work retains its existing delivery policy. An unrelated destination record is never deleted.

## Monitoring interpretation

- `blocked > 0`: delivery needs operator intervention.
- `retrying > 0`: transient delivery failures are being retried.
- Increasing `oldestPendingAgeMs`: work is waiting too long, even if the source remains active.
- Increasing `quarantined`: the source contract or an event's data needs inspection.
- `stale: true`: there have been no newly accepted snapshots within the configured interval; this requires a source-specific interpretation, especially outside active sales periods.

These are exposed signals. Connect them to an alert receiver and define a runbook before using an actual customer feed.
