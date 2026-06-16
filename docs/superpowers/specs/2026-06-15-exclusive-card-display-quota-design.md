# Exclusive Card Display Quota Design

Date: 2026-06-15
Scope: `apps/bcai-wails` desktop client quota display, especially the dashboard blood bars.

## Background

The desktop client currently shows two quota perspectives:

- Account remaining quota: the real upstream account window/fraction.
- My card quota: the card's own static bucket or fair-share allocation.

For normal shared cards, this distinction is useful. Users should understand when the upstream account is tight versus when their own allocation is tight.

For exclusive cards, the product expectation is different. An exclusive card occupies the whole share capacity, for example `weight === shareCapacity === 8`. The customer experiences the card as their own dedicated quota package. If the same underlying account is also temporarily placed in a pool, the real account bar can decrease because of other usage. Showing that real account decrease to an exclusive-card customer creates confusion: they see "account remaining quota" drop even though they did not consume it.

## Goal

For exclusive cards only, keep the existing wording such as "account remaining", "account 5h", and "account 7d", but map those displayed values to the card's own quota perspective.

This is a client display rule. It does not change quota enforcement, leasing, fair-share calculation, account pooling, reporting, or server-side billing.

## Exclusive Card Definition

A card is exclusive when:

```ts
cardShareCapacity > 0 && cardWeight >= cardShareCapacity
```

In current production data this corresponds to an exclusive `8/8` card.

Use `>=` instead of strict equality so the UI is robust if old data or admin tooling produces an over-capacity weight. The display rule still only activates when `shareCapacity` is positive.

## Display Rules

### Non-exclusive Cards

Keep the current behavior:

- Account bars use `accountFractions`, `accountResetMs`, `codexQuota`, and `claudeQuota`.
- My-card bars use `myFractions`, `myResetMs`, `myWeeklyFractions`, `myWeeklyResetMs`, or static card bucket data.
- Account and card perspectives remain visibly separate.

### Exclusive Cards

The UI still renders the same labels and row structure, but account-labeled bars use card-scope data:

- Single account bar: use the same fraction/reset source as the card bar for that bucket.
- Codex account `5h`: use the card's `5h` fraction/reset for `codex-gpt`.
- Codex account `7d`: use the card's weekly fraction/reset for `codex-gpt` when available.
- Anthropic account `5h`: use the card's `5h` fraction/reset for `anthropic-claude`.
- Anthropic account `7d`: use the card's weekly fraction/reset for `anthropic-claude` when available.
- Antigravity account bars use card-scope bucket or fair-share data for `antigravity-gemini` / `antigravity-claude`.

The real upstream account quota remains available internally, but is not used for exclusive-card account-labeled display rows.

## Data Source Priority

For an exclusive card, the display mapper should derive a card-scope bar value per bucket:

1. Static bucket data from `cardBuckets[bucket]`:
   - fraction = `(limit - used) / limit`, clamped to `0..1`.
   - reset = `cardBuckets[bucket].resetMs`.
2. Dynamic fair-share data from `myFractions[bucket]`:
   - fraction = `myFractions[bucket]`.
   - reset = `myResetMs[bucket]`.
3. Weekly card data:
   - static weekly = `cardWeeklyBuckets[bucket]`.
   - dynamic weekly = `myWeeklyFractions[bucket]` and `myWeeklyResetMs[bucket]`.
4. If no card-scope data exists for the requested bar, fall back to the existing unknown behavior (`fraction = -1`) rather than showing the real account quota.

This preserves the concealment goal: an exclusive-card customer should not see pooled-account movement through the account-labeled blood bar.

## Account Problems

The existing `accountProblem` handling remains authoritative. If the current account has a non-quota runtime problem, the UI should still show the warning and mark blood bars as unknown.

This prevents a mismatch where the UI says the quota is available but requests cannot actually proceed.

Quota-like errors remain treated as quota state, not account failure, matching the existing code path.

## Components

### `DashboardPage.tsx`

Add a small derived flag:

```ts
const isExclusiveCard = cardShareCapacity > 0 && cardWeight >= cardShareCapacity
```

Introduce local helpers that return card-scope display data by bucket:

- `cardScopeFiveHour(bar)`
- `cardScopeWeekly(bar)`
- `exclusiveAccountBars(bar)`

The existing `modelRows(bar)` function should choose:

- exclusive path when `isExclusiveCard` is true.
- current account path when false.

This keeps the behavior localized to the dashboard rendering layer.

### `UsageBar.tsx`

No structural change is required. It already accepts `fraction` and `resetMs`, and it already handles `-1` as unknown.

### Store and Backend

No backend contract change is required.

The store already exposes:

- `cardWeight`
- `cardShareCapacity`
- `cardBuckets`
- `cardWeeklyBuckets`
- `myFractions`
- `myResetMs`
- `myWeeklyFractions`
- `myWeeklyResetMs`

## Testing

Add focused frontend tests around a pure helper if extracted, or around dashboard mapping if kept local:

- Exclusive static card: account-labeled bar uses `cardBuckets`, not `accountFractions`.
- Exclusive dynamic card: account-labeled bar uses `myFractions`, not `accountFractions`.
- Exclusive weekly Codex/Anthropic: account `7d` uses `cardWeeklyBuckets` or `myWeeklyFractions`.
- Missing card-scope data: account-labeled bar shows unknown instead of falling back to real account quota.
- Non-exclusive card: current behavior is unchanged.

Existing Go bloodbar tests do not need to change because this is a client display mapping, not backend quota state.

## Non-goals

- Do not change server-side fair-share calculation.
- Do not change account pooling or lease selection.
- Do not change quota enforcement.
- Do not expose a new user-facing label that says "exclusive card display".
- Do not remove real account quota from internal state.

## Risks

The main risk is accidentally applying the mapping to shared cards. The `isExclusiveCard` guard must be explicit and covered by tests.

The second risk is showing a healthy card-scope bar while the real account cannot serve requests. Keeping the existing `accountProblem` override avoids that.
