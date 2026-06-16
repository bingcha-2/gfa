# Exclusive Card Display Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make exclusive-card customers see account-labeled blood bars from their own card quota perspective while shared-card customers keep the current real-account display.

**Architecture:** Add a small pure mapping module in the Wails frontend that resolves card-scope display fractions and reset timers from existing store fields. `DashboardPage.tsx` will use that mapper only when `cardWeight >= cardShareCapacity`, keeping backend contracts unchanged and leaving `UsageBar.tsx` untouched.

**Tech Stack:** React 19, TypeScript, Zustand store data, Vitest, Wails frontend under `apps/bcai-wails/frontend`.

---

## File Structure

- Create `apps/bcai-wails/frontend/src/lib/quotaDisplay.ts`: pure helper functions for exclusive-card detection and card-scope quota display values.
- Create `apps/bcai-wails/frontend/src/lib/quotaDisplay.test.ts`: focused tests for static, dynamic, weekly, missing data, and non-exclusive behavior.
- Modify `apps/bcai-wails/frontend/src/pages/DashboardPage.tsx`: import the helper and switch account-labeled blood bars to card-scope values only for exclusive cards.

No backend files change. No store contract changes. `UsageBar.tsx` remains unchanged.

---

### Task 1: Add Pure Quota Display Mapper

**Files:**
- Create: `apps/bcai-wails/frontend/src/lib/quotaDisplay.ts`
- Test: `apps/bcai-wails/frontend/src/lib/quotaDisplay.test.ts`

- [ ] **Step 1: Write failing tests for exclusive-card mapping**

Create `apps/bcai-wails/frontend/src/lib/quotaDisplay.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  cardScopeFiveHour,
  cardScopeWeekly,
  isExclusiveCard,
  shouldUseExclusiveDisplay,
} from './quotaDisplay'

describe('isExclusiveCard', () => {
  it('treats full-capacity cards as exclusive', () => {
    expect(isExclusiveCard(8, 8)).toBe(true)
    expect(isExclusiveCard(9, 8)).toBe(true)
  })

  it('does not treat shared or missing-capacity cards as exclusive', () => {
    expect(isExclusiveCard(1, 8)).toBe(false)
    expect(isExclusiveCard(8, 0)).toBe(false)
  })
})

describe('shouldUseExclusiveDisplay', () => {
  it('requires both exclusivity and no account problem', () => {
    expect(shouldUseExclusiveDisplay({ cardWeight: 8, cardShareCapacity: 8, accountProblem: false })).toBe(true)
    expect(shouldUseExclusiveDisplay({ cardWeight: 8, cardShareCapacity: 8, accountProblem: true })).toBe(false)
    expect(shouldUseExclusiveDisplay({ cardWeight: 1, cardShareCapacity: 8, accountProblem: false })).toBe(false)
  })
})

describe('cardScopeFiveHour', () => {
  it('uses static card bucket data before account fractions', () => {
    const got = cardScopeFiveHour('codex-gpt', {
      cardBuckets: {
        'codex-gpt': { used: 25, limit: 100, resetMs: 1234 },
      },
      myFractions: {
        'codex-gpt': 0.2,
      },
      myResetMs: {
        'codex-gpt': 9999,
      },
    })

    expect(got).toEqual({ fraction: 0.75, resetMs: 1234 })
  })

  it('uses dynamic fair-share data when no static bucket exists', () => {
    const got = cardScopeFiveHour('anthropic-claude', {
      myFractions: {
        'anthropic-claude': 0.4,
      },
      myResetMs: {
        'anthropic-claude': 2222,
      },
    })

    expect(got).toEqual({ fraction: 0.4, resetMs: 2222 })
  })

  it('returns unknown when exclusive display has no card-scope data', () => {
    const got = cardScopeFiveHour('antigravity-gemini', {
      cardBuckets: {},
      myFractions: {},
      myResetMs: {},
    })

    expect(got).toEqual({ fraction: -1, resetMs: undefined })
  })
})

describe('cardScopeWeekly', () => {
  it('uses static weekly bucket data before dynamic weekly fair-share data', () => {
    const got = cardScopeWeekly('codex-gpt', {
      cardWeeklyBuckets: {
        'codex-gpt': { used: 40, limit: 100, resetMs: 7777 },
      },
      myWeeklyFractions: {
        'codex-gpt': 0.1,
      },
      myWeeklyResetMs: {
        'codex-gpt': 1111,
      },
    })

    expect(got).toEqual({ fraction: 0.6, resetMs: 7777 })
  })

  it('uses dynamic weekly fair-share data when no static weekly bucket exists', () => {
    const got = cardScopeWeekly('anthropic-claude', {
      myWeeklyFractions: {
        'anthropic-claude': 0.35,
      },
      myWeeklyResetMs: {
        'anthropic-claude': 3333,
      },
    })

    expect(got).toEqual({ fraction: 0.35, resetMs: 3333 })
  })

  it('returns unknown when weekly card-scope data is absent', () => {
    const got = cardScopeWeekly('codex-gpt', {})

    expect(got).toEqual({ fraction: -1, resetMs: undefined })
  })
})
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
cd apps/bcai-wails/frontend
npm test -- src/lib/quotaDisplay.test.ts
```

Expected: FAIL because `src/lib/quotaDisplay.ts` does not exist.

- [ ] **Step 3: Implement the mapper**

Create `apps/bcai-wails/frontend/src/lib/quotaDisplay.ts`:

```ts
type BucketValue = {
  used: number
  limit: number
  resetMs?: number
}

export type DisplayQuotaValue = {
  fraction: number
  resetMs?: number
}

export type CardScopeQuotaInput = {
  cardBuckets?: Record<string, BucketValue>
  cardWeeklyBuckets?: Record<string, BucketValue>
  myFractions?: Record<string, number>
  myResetMs?: Record<string, number>
  myWeeklyFractions?: Record<string, number>
  myWeeklyResetMs?: Record<string, number>
}

export function isExclusiveCard(cardWeight: number, cardShareCapacity: number): boolean {
  return cardShareCapacity > 0 && cardWeight >= cardShareCapacity
}

export function shouldUseExclusiveDisplay({
  cardWeight,
  cardShareCapacity,
  accountProblem,
}: {
  cardWeight: number
  cardShareCapacity: number
  accountProblem: boolean
}): boolean {
  return isExclusiveCard(cardWeight, cardShareCapacity) && !accountProblem
}

function fractionFromBucket(bucket: BucketValue | undefined): DisplayQuotaValue | null {
  if (!bucket || bucket.limit <= 0) return null
  const fraction = Math.max(0, Math.min(1, (bucket.limit - bucket.used) / bucket.limit))
  return { fraction, resetMs: bucket.resetMs }
}

function fractionFromMap(
  bucket: string,
  fractions: Record<string, number> | undefined,
  resets: Record<string, number> | undefined,
): DisplayQuotaValue | null {
  const fraction = fractions?.[bucket]
  if (fraction == null) return null
  return { fraction, resetMs: resets?.[bucket] }
}

function unknownQuota(): DisplayQuotaValue {
  return { fraction: -1, resetMs: undefined }
}

export function cardScopeFiveHour(bucket: string, input: CardScopeQuotaInput): DisplayQuotaValue {
  return (
    fractionFromBucket(input.cardBuckets?.[bucket]) ??
    fractionFromMap(bucket, input.myFractions, input.myResetMs) ??
    unknownQuota()
  )
}

export function cardScopeWeekly(bucket: string, input: CardScopeQuotaInput): DisplayQuotaValue {
  return (
    fractionFromBucket(input.cardWeeklyBuckets?.[bucket]) ??
    fractionFromMap(bucket, input.myWeeklyFractions, input.myWeeklyResetMs) ??
    unknownQuota()
  )
}
```

- [ ] **Step 4: Run mapper tests and verify they pass**

Run:

```bash
cd apps/bcai-wails/frontend
npm test -- src/lib/quotaDisplay.test.ts
```

Expected: PASS, one test file passes.

- [ ] **Step 5: Commit mapper and tests**

Run:

```bash
git add apps/bcai-wails/frontend/src/lib/quotaDisplay.ts apps/bcai-wails/frontend/src/lib/quotaDisplay.test.ts
git commit -m "feat: add exclusive card quota display mapper"
```

Expected: a commit containing only the new mapper and test file.

---

### Task 2: Wire Exclusive Display Into Dashboard

**Files:**
- Modify: `apps/bcai-wails/frontend/src/pages/DashboardPage.tsx`
- Test: `apps/bcai-wails/frontend/src/lib/quotaDisplay.test.ts`

- [ ] **Step 1: Add an integration-shaped helper test for account display selection**

Extend `apps/bcai-wails/frontend/src/lib/quotaDisplay.test.ts` with this import:

```ts
import {
  cardScopeFiveHour,
  cardScopeWeekly,
  isExclusiveCard,
  shouldUseExclusiveDisplay,
} from './quotaDisplay'
```

Then add these tests at the end:

```ts
describe('exclusive account display selection', () => {
  it('lets dashboard replace account 5h display with card-scope 5h display', () => {
    const exclusive = shouldUseExclusiveDisplay({ cardWeight: 8, cardShareCapacity: 8, accountProblem: false })
    const accountFraction = 0.05
    const display = exclusive
      ? cardScopeFiveHour('codex-gpt', {
          myFractions: { 'codex-gpt': 0.8 },
          myResetMs: { 'codex-gpt': 5000 },
        })
      : { fraction: accountFraction, resetMs: 1000 }

    expect(display).toEqual({ fraction: 0.8, resetMs: 5000 })
  })

  it('keeps non-exclusive dashboard display on real account data', () => {
    const exclusive = shouldUseExclusiveDisplay({ cardWeight: 1, cardShareCapacity: 8, accountProblem: false })
    const accountFraction = 0.05
    const display = exclusive
      ? cardScopeFiveHour('codex-gpt', {
          myFractions: { 'codex-gpt': 0.8 },
          myResetMs: { 'codex-gpt': 5000 },
        })
      : { fraction: accountFraction, resetMs: 1000 }

    expect(display).toEqual({ fraction: 0.05, resetMs: 1000 })
  })

  it('lets dashboard replace account weekly display with card-scope weekly display', () => {
    const exclusive = shouldUseExclusiveDisplay({ cardWeight: 8, cardShareCapacity: 8, accountProblem: false })
    const display = exclusive
      ? cardScopeWeekly('anthropic-claude', {
          myWeeklyFractions: { 'anthropic-claude': 0.7 },
          myWeeklyResetMs: { 'anthropic-claude': 7000 },
        })
      : { fraction: 0.2, resetMs: 2000 }

    expect(display).toEqual({ fraction: 0.7, resetMs: 7000 })
  })
})
```

- [ ] **Step 2: Run the selection tests**

Run:

```bash
cd apps/bcai-wails/frontend
npm test -- src/lib/quotaDisplay.test.ts
```

Expected: PASS. These tests document the dashboard selection behavior before editing the dashboard.

- [ ] **Step 3: Import the mapper in DashboardPage**

Modify the imports near the top of `apps/bcai-wails/frontend/src/pages/DashboardPage.tsx`:

```ts
import { cardScopeFiveHour, cardScopeWeekly, shouldUseExclusiveDisplay } from '@/lib/quotaDisplay'
```

- [ ] **Step 4: Add the exclusive-display flag and card-scope input**

Inside `DashboardPage`, after `const accountProblem = ...`, add:

```ts
  const useExclusiveDisplay = shouldUseExclusiveDisplay({
    cardWeight,
    cardShareCapacity,
    accountProblem,
  })
  const cardScopeInput = {
    cardBuckets,
    cardWeeklyBuckets,
    myFractions,
    myResetMs,
    myWeeklyFractions,
    myWeeklyResetMs,
  }
```

- [ ] **Step 5: Replace account-row display selection in `modelRows`**

In `modelRows(bar)`, replace the existing `const split = ...` and `const accountBars = ...` block with:

```tsx
              const accountBars = (() => {
                if (useExclusiveDisplay) {
                  const fiveHour = cardScopeFiveHour(bar.bucket, cardScopeInput)
                  if (bar.family === 'gpt' || bar.bucket === 'anthropic-claude') {
                    const weekly = cardScopeWeekly(bar.bucket, cardScopeInput)
                    return [
                      <UsageBar key="acct-5h" label={t('dashboard.acct5h')} used={null} limit={null}
                        fraction={fiveHour.fraction} resetMs={fiveHour.resetMs} />,
                      <UsageBar key="acct-week" label={t('dashboard.acctWeek')} used={null} limit={null}
                        fraction={weekly.fraction} resetMs={weekly.resetMs} />,
                    ]
                  }
                  return [
                    <UsageBar key="acct" label={t('dashboard.acctRemaining')} used={null} limit={null}
                      fraction={fiveHour.fraction} resetMs={fiveHour.resetMs} />,
                  ]
                }

                const split =
                  bar.family === 'gpt' && codexQuota && !accountProblem ? codexQuota :
                  bar.bucket === 'anthropic-claude' && claudeQuota && !accountProblem ? claudeQuota : null
                return split ? [
                  <UsageBar key="acct-5h" label={t('dashboard.acct5h')} used={null} limit={null}
                    fraction={split.hourlyFraction} resetMs={split.hourlyResetMs} />,
                  <UsageBar key="acct-week" label={t('dashboard.acctWeek')} used={null} limit={null}
                    fraction={split.weeklyFraction} resetMs={split.weeklyResetMs} />,
                ] : [
                  <UsageBar key="acct" label={t('dashboard.acctRemaining')} used={null} limit={null}
                    fraction={accountFractions?.[bar.bucket] ?? -1}
                    resetMs={accountResetMs?.[bar.bucket]} />,
                ]
              })()
```

This preserves current shared-card behavior and only swaps account-labeled bars to card-scope display when the card is exclusive and the account is not in a problem state.

- [ ] **Step 6: Run frontend tests for quota display and existing blood bars**

Run:

```bash
cd apps/bcai-wails/frontend
npm test -- src/lib/quotaDisplay.test.ts src/lib/bloodBar.test.ts src/components/UsageBar.test.tsx src/lib/usageBars.test.ts
```

Expected: PASS, all selected quota-display tests pass.

- [ ] **Step 7: Run TypeScript build check**

Run:

```bash
cd apps/bcai-wails/frontend
npm run build
```

Expected: `tsc && vite build` completes successfully.

- [ ] **Step 8: Commit dashboard wiring**

Run:

```bash
git add apps/bcai-wails/frontend/src/pages/DashboardPage.tsx apps/bcai-wails/frontend/src/lib/quotaDisplay.test.ts
git commit -m "feat: map exclusive card account bars to card quota"
```

Expected: a commit containing the dashboard integration and expanded tests.

---

### Task 3: Verify Final Behavior

**Files:**
- Read: `apps/bcai-wails/frontend/src/pages/DashboardPage.tsx`
- Read: `apps/bcai-wails/frontend/src/lib/quotaDisplay.ts`

- [ ] **Step 1: Verify no backend files changed**

Run:

```bash
git diff --name-only HEAD~2..HEAD
```

Expected output includes only:

```text
apps/bcai-wails/frontend/src/lib/quotaDisplay.ts
apps/bcai-wails/frontend/src/lib/quotaDisplay.test.ts
apps/bcai-wails/frontend/src/pages/DashboardPage.tsx
```

- [ ] **Step 2: Run focused frontend tests again**

Run:

```bash
cd apps/bcai-wails/frontend
npm test -- src/lib/quotaDisplay.test.ts src/lib/bloodBar.test.ts src/components/UsageBar.test.tsx src/lib/usageBars.test.ts
```

Expected: PASS.

- [ ] **Step 3: Summarize behavior in final response**

The final response should state:

- Exclusive detection is `cardShareCapacity > 0 && cardWeight >= cardShareCapacity`.
- Exclusive cards keep account labels but display card-scope quota data.
- Shared cards keep existing real-account quota display.
- Backend quota enforcement and leasing were not changed.
