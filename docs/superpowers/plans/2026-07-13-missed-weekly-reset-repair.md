# Missed Weekly Reset Exact Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dry-run-first one-off tool that removes pre-reset Codex weekly accounting while reconstructing and preserving every persisted post-reset usage event.

**Architecture:** A pure repair module validates one exported candidate and rebuilds its weekly state by replaying authoritative quota snapshots plus per-request events from `Subscription.windowState` through the production reducer. A thin CLI reads SQLite, invokes the pure planner, and atomically checkpoints the rebuilt weekly state together with the untouched primary state.

**Tech Stack:** TypeScript, Vitest, Prisma/SQLite, existing `calculateQuotaCu`, `reduceWindow`, and `FairShareWindowRepository`.

---

## File Structure

- Create `apps/server/src/leasing/quota/missed-weekly-reset-repair.ts`: export parsing, persisted-event validation, causal reconstruction, and repair statistics.
- Create `apps/server/src/leasing/quota/missed-weekly-reset-repair.spec.ts`: account-19 fixture plus rejection/idempotency coverage.
- Create `apps/server/scripts/repair-missed-weekly-reset.ts`: argument parsing, production reads, dry-run output, and guarded checkpoint.
- Modify `apps/server/package.json`: expose a stable `quota:repair-missed-weekly-reset` command.

### Task 1: Pure candidate and usage parsing

**Files:**
- Create: `apps/server/src/leasing/quota/missed-weekly-reset-repair.ts`
- Test: `apps/server/src/leasing/quota/missed-weekly-reset-repair.spec.ts`

- [ ] **Step 1: Write failing parser tests**

Cover selection of only `codex/codex-gpt/weekly` candidates with a current head, conversion of persisted gross input into net input, `priority` into `fast`, filtering before the missed reset, and filtering non-`codex-gpt` events.

```ts
expect(parsePersistedUsageEvents({
  quotaSubjectId: "card-a",
  bucket: "codex-gpt",
  missedResetAt: RESET_AT,
  windowState: JSON.stringify({ weeklyTokenUsageEvents: [
    { at: RESET_AT - 1, inputTokens: 10, outputTokens: 0, cachedInputTokens: 0, modelKey: "gpt-5", product: "codex" },
    { at: RESET_AT + 1, inputTokens: 100, outputTokens: 5, cachedInputTokens: 40, modelKey: "gpt-5", product: "codex", serviceTier: "priority" },
  ] }),
})).toMatchObject([{ inputTokens: 60, cachedInputTokens: 40, outputTokens: 5, serviceTier: "fast" }]);
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `pnpm --filter @gfa/server test -- src/leasing/quota/missed-weekly-reset-repair.spec.ts`

Expected: FAIL because the repair module does not exist.

- [ ] **Step 3: Implement strict parsers**

Export typed `MissedResetCandidate`, `RepairSnapshot`, `PersistedRepairUsage`, `parseRepairExport`, and `parsePersistedUsageEvents`. Reject non-finite timestamps/token counts and malformed JSON; treat a null `windowState` as an empty persisted window because the normal persister omits inactive windows.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `pnpm --filter @gfa/server test -- src/leasing/quota/missed-weekly-reset-repair.spec.ts`

Expected: parser tests PASS.

### Task 2: Account-19 reconstruction

**Files:**
- Modify: `apps/server/src/leasing/quota/missed-weekly-reset-repair.ts`
- Modify: `apps/server/src/leasing/quota/missed-weekly-reset-repair.spec.ts`

- [ ] **Step 1: Write the account-19 failing test**

Build a current weekly fixture at fraction `0.74`, reset boundary `2026-07-20T00:06:05Z`, carried burn `0.075555555556`, and assigned burn `0.184444444444`. Supply the real missed-reset start fraction `0.86`, post-reset usage for two subjects, and a later `0.74` snapshot.

```ts
const result = reconstructMissedWeeklyReset({ candidate, current, snapshots, usageEvents });
expect(result.ok).toBe(true);
if (result.ok) {
  expect(result.windows.primary).toBe(current.primary);
  expect(result.windows.weekly.fraction).toBeCloseTo(0.74, 12);
  expect(result.windows.weekly.assignedBurn).toBeCloseTo(0.12, 12);
  expect(Object.values(result.windows.weekly.subjects)
    .reduce((sum, s) => sum + s.carriedAttributedShare, 0)).toBe(0);
  expect(Object.values(result.windows.weekly.subjects)
    .reduce((sum, s) => sum + s.cumulativeCu, 0)).toBeGreaterThan(0);
}
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run the focused Vitest command and expect failure because reconstruction is absent.

- [ ] **Step 3: Implement causal reconstruction**

Create a clean weekly state from the current head's complete subject configuration. Feed the matching first new-window snapshot, merge subsequent snapshots with calculated usage events, sort by reducer causal order (usage before snapshot on equal timestamps), and call `reduceWindow` for every event. Apply one final membership event with current subject flags/shares. Set the weekly revision to at least `current.weekly.revision + 1`; leave primary unchanged.

- [ ] **Step 4: Add safety-gate tests**

Test rejection for reset-boundary mismatch, missing starting snapshot, malformed event history, non-finite CU, replayed final fraction mismatch, and a head whose exported carry fingerprint is already gone.

- [ ] **Step 5: Run the focused suite and confirm GREEN**

Expected: all reconstruction and rejection tests PASS.

### Task 3: Dry-run/apply CLI

**Files:**
- Create: `apps/server/scripts/repair-missed-weekly-reset.ts`
- Modify: `apps/server/package.json`

- [ ] **Step 1: Implement CLI argument and database loading**

Support `--input=<path>` and `--apply`; default to dry-run. Resolve `DATABASE_URL` using the same repository-root-relative SQLite convention as existing server scripts. Load current heads through `FairShareWindowRepository`, relevant `AccountQuotaSnapshot` rows, and each current subject's `Subscription.windowState`.

- [ ] **Step 2: Implement dry-run report**

Print one line per candidate with `READY`, `SKIP`, or `REJECT`, plus old/rebuilt CU, old/rebuilt burn, post-reset event count, current fraction, and reason. Exit non-zero when any account is rejected.

- [ ] **Step 3: Implement guarded apply**

In apply mode, re-read the durable head revision immediately before `checkpointAccount`; reject a changed revision. Checkpoint `{ primary: unchangedPrimary, weekly: rebuiltWeekly }` through `FairShareWindowRepository` so the head and both per-card summaries stay atomic. Do not write any other table.

- [ ] **Step 4: Add the package command**

```json
"quota:repair-missed-weekly-reset": "tsx scripts/repair-missed-weekly-reset.ts"
```

### Task 4: Verification and handoff

**Files:**
- Verify: `exports/quota-missed-reset-20260713T081047Z.json`

- [ ] **Step 1: Run focused tests**

Run: `pnpm --filter @gfa/server test -- src/leasing/quota/missed-weekly-reset-repair.spec.ts`

Expected: PASS.

- [ ] **Step 2: Run server typecheck**

Run: `pnpm --filter @gfa/server lint`

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Run the complete server test suite**

Run: `pnpm --filter @gfa/server test`

Expected: all server tests PASS.

- [ ] **Step 4: Run export-only validation**

Run the CLI against the checked-in export and a non-production database in dry-run mode. Confirm it never writes without `--apply` and reports absent live heads as skips rather than fabricating state.

- [ ] **Step 5: Commit only repair files**

Stage the new module, its test, CLI, package script, and this plan. Do not stage the pre-existing dirty fair-share/repository/token-server files.
