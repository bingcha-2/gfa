# Quota Final Hardening Design

## Goal

Make quota accounting stable under reordered snapshots/reports, process restarts,
subscription changes, long requests, and SQLite failures without pausing account
traffic, enabling WAL, or adding a per-request event table.

## Decisions

### Reorder window

- Keep up to 10 minutes of causal events in memory.
- Each window is bounded by 10,000 events or 1 MiB, whichever is reached first.
- The process-wide reorder budget is 128 MiB. When it is exceeded, collapse the
  oldest tails into their materialized summaries and continue serving.
- In-order events use an incremental fast path. Only genuinely reordered events
  replay the retained tail.
- Capacity compaction is conservative and observable through the existing
  diagnostic reason fields. It never pauses leasing.

### SQLite checkpoint

- SQLite stores the materialized quota summary and receipts, not the full
  in-memory 1 MiB reorder tail.
- A restart preserves the latest mother fraction, per-subject CU, attribution,
  reset boundary, revision, and receipt deduplication.
- A restart may discard the pre-restart ordering detail. A later old event then
  follows the existing evidence-missing conservative path and is logged.
- Window state, report receipt, and hourly accounting remain one transaction.
- A stale revision is a failed checkpoint. The server must not acknowledge the
  report as successful.

### Request-to-account attribution

- The in-memory lease record is already a credential-free mapping from lease ID
  to card and upstream account.
- An unreported lease remains available for attribution even after token expiry.
- A completed report deletes its lease record immediately after successful
  processing.
- Abandoned records are bounded by a 100,000-entry cap; oldest expired records
  are evicted only when the cap is exceeded. There is no arbitrary multi-hour
  waiting period and no new database table.

### Startup readiness

- Subscription rows must load successfully before leasing starts.
- Deferred membership reconciliation and its checkpoint must finish before the
  readiness barrier is released.
- Fair-share state load failures fail startup instead of serving empty quota
  state.
- Retry timers are cancelled on shutdown.

### Client state

- Login, logout, forced logout, and account changes clear quota bars,
  entitlements, local quota, and stale errors.
- They do not delete local token history or cumulative API value.
- Missing `personalFraction` explicitly clears a previous personal value so a
  server rollback cannot freeze the old bar.

### Diagnostics

- Existing request and snapshot logs retain their current 72-hour policy and
  row cap; no new log table is added.
- Failed request-log batches return to the bounded queue.
- Tail compaction records reason, count, retained event count, retained bytes,
  account, bucket, scope, and revision through existing diagnostic fields.

### Quota UX and cold start

- When a subject still has personal quota but the mother account has no usable
  quota, return `account_recovering` with the dedicated Chinese message.
- On a completely missing window state, prior mother burn is assigned to a card
  only when there is exactly one active subject, it is explicitly exclusive,
  and it owns the full share. Multi-user and oversold pools remain unattributed.

### Pricing sources

- Window-CU quota calculation uses `quota-rates.json` exclusively.
- Codex and Anthropic API value uses `api-pricing.json`, including unknown-model
  conservative fallback.
- Legacy family pricing remains only for products not represented in the new
  API pricing registry; it must not be used by model-aware Codex/Anthropic paths.

## Verification

Tests must cover capacity and global compaction, in-order fast-path equivalence,
snapshot/report permutations, compact checkpoint restart, stale revisions,
checkpoint failure and duplicate retry, real startup subscription failure and
recovery, fair-share load failure, long completion after lease expiry, auth
state changes without usage-history deletion, old-server personal-field absence,
diagnostic requeue, account recovery, exclusive cold start, official resets,
membership join/leave/rebind, and full client-server E2E regression.
