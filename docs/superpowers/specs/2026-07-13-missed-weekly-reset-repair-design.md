# Missed Weekly Reset Exact Repair Design

## Goal

Repair the Codex weekly fair-share heads damaged by the early-reset reducer bug without forgiving usage that occurred after the real upstream reset. The repair is a one-off, explicit production operation driven by `exports/quota-missed-reset-20260713T081047Z.json`.

## Scope

- Provider: `codex`
- Bucket: `codex-gpt`
- Scope: `weekly` only
- Candidate accounts come from the export; a candidate without a current weekly head is skipped.
- The primary/5h window, upstream quota snapshots, report receipts, subscriptions, and hourly usage aggregates are never modified.

## Data Sources

The candidate export supplies the missed-reset transition for each account: observation time, old/new `resetAt`, and old/new fraction. The live database supplies:

- the current `FairShareWindowHead`, including membership and revision;
- `Subscription.windowState.weeklyTokenUsageEvents`, which retains per-request timestamp, model, input/output/cache tokens, product, and service tier;
- `AccountQuotaSnapshot`, which supplies the post-reset weekly fraction timeline.

The script uses the same `calculateQuotaCu` and fair-share reducer as production. It does not estimate CU from `RequestLog.totalTokens` or hourly aggregates.

## Reconstruction

For each candidate account:

1. Validate that the current weekly head still points at the detected new reset boundary and still contains the exported pre-reset carry fingerprint; an already-clean head is skipped.
2. Create a clean weekly state with the current head's complete subject configuration.
3. Prime it with the first real new-window snapshot from `AccountQuotaSnapshot`.
4. Read every affected subscription's persisted weekly token events, retain only Codex GPT-bucket events whose timestamp is at or after the missed reset, and calculate CU using the production rate function.
5. Merge usage events and subsequent quota snapshots by causal timestamp and replay them through the production weekly reducer.
6. Apply current membership once more so current active/share/exclusive configuration is preserved while departed subjects' post-reset accounting remains represented.
7. Preserve the current primary state, increment the reconstructed weekly revision beyond the durable revision, and checkpoint both scopes atomically through `FairShareWindowRepository`. This also synchronizes `FairShareWindow` summaries.

The result contains only new-window usage and new-window fraction changes. Pre-reset CU, carry, attribution, and reorder-tail events cannot survive reconstruction.

## Safety Gates

The script defaults to dry-run. `--apply` is required for writes. An account is rejected, not partially repaired, when any of these checks fails:

- candidate transition or current head is missing or inconsistent;
- no authoritative starting snapshot exists;
- a referenced subject or `windowState` is malformed;
- replayed final reset boundary or fraction differs from the latest authoritative snapshot;
- reconstructed CU is non-finite or negative;
- the durable revision changed between read and checkpoint.

Dry-run prints per account: reset boundary, current and reconstructed fraction, old versus reconstructed CU/burn, event counts, affected subjects, and the exact skip/reject reason. Apply runs only accounts that passed all gates and reports each committed account independently.

## Operation

Production must run the reducer fix before repair. Stop the service gracefully so subscription window snapshots and fair-share heads are flushed, back up the SQLite database, then run:

```powershell
pnpm tsx scripts/repair-missed-weekly-reset.ts --input=exports/quota-missed-reset-20260713T081047Z.json
pnpm tsx scripts/repair-missed-weekly-reset.ts --input=exports/quota-missed-reset-20260713T081047Z.json --apply
```

Restart only after the apply report shows no unexpected rejection. Re-running the script is safe: repaired accounts no longer satisfy the contaminated-head gate and are skipped.

## Verification

Unit tests cover transition selection, post-reset event filtering, causal replay, primary preservation, malformed/missing history rejection, stale revision rejection, and idempotent second execution. A fixture based on account 19 verifies that the old 14% baseline burn is removed while post-reset usage and the current mother fraction remain.
