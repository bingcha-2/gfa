# Quota Lease Retention and Stale-Batch Isolation Design

**Status:** approved for implementation

## Goal

Prevent a reusable live lease from losing attribution after the ten-minute causal horizon, and prevent one stale quota checkpoint from failing unrelated accounts in the same SQLite micro-batch.

## Lease lifecycle

A terminal report sets `reportedAt`, but the lease mapping remains reusable until both conditions are true:

- the ten-minute causal reorder horizon has passed; and
- the lease's own `expiresAt` has passed.

The existing 100,000-record capacity guard still evicts only expired mappings and never evicts a live lease.

## Checkpoint isolation

The normal path keeps one SQLite transaction for the whole coordinator micro-batch. If SQLite rejects a stale account revision, the repository records that account's coordinator key, removes it from the candidate batch, and retries the remaining accounts together. This repeats only on the exceptional stale path; ordinary traffic retains group commit.

After healthy siblings commit, the repository throws one `QuotaStaleRevisionError` containing only the stale keys. `QuotaWriteCoordinator` interprets this as a partial result: it rejects waiters for stale keys and resolves/advances persisted revisions for healthy keys. Non-stale database errors retain the existing all-fail behavior.

## Required invariants

- A stale account never writes either scope, a receipt, or hourly accounting.
- A healthy sibling writes both scopes, receipts, and hourly accounting atomically.
- A healthy caller never receives a false failure because another key is stale.
- The next scheduled flush is not poisoned by a stale sibling.
- The ordinary no-stale path still performs one batch transaction.

