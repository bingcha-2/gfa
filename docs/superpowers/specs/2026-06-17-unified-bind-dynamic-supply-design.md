# Unified Bind Line With Dynamic Supply Design

Date: 2026-06-17
Scope: customer subscriptions, plan catalog, admin capacity controls, lease scheduling, quota display, and legacy card migration.

## Background

The system currently exposes two customer-facing lines:

- Pool line: static card quota through `bucketLimits` / `weeklyTokenLimit`, no account seat binding, runtime leases from the dynamic pool.
- Bind line: product membership level + `bindings` + `weight`, consumes account shares and pins lease traffic to the bound upstream account.

This split creates two product problems:

- Pool line has better utilization because unused upstream quota can be absorbed by other customers, but it weakens the "bound car" product story.
- Bind line has a clear customer story, but the current implementation treats the bound account as the only runtime account. When that account runs out while the customer's subscription quota remains, the customer is blocked.

The target product direction is to remove the customer-visible pool line and keep a unified bind-line buying experience, while preserving utilization through dynamic backend supply.

## Goals

- Customers buy a stable quota entitlement by product and seat count.
- Customers only see product type, seats, price, and blood-bar style quota. They do not see backend account assignment, overbooking, or fallback.
- The backend can overbook accounts by a configurable seat count.
- The preferred initial account is tried first, but runtime leasing may switch accounts when the preferred account has no quota or is unhealthy.
- Client quota display feels stable and accurate: the customer's own quota only moves when that customer uses it.
- The current service account display reflects the actual account used by the latest lease, so account blood bars do not contradict runtime switching.
- Existing cards migrate without changing purchased quota.

## Non-Goals

- Do not expose overbooking, account seat availability, or fallback routing to customers.
- Do not make the learned quota profile directly visible to customers.
- Do not reset old card usage windows during migration.
- Do not keep `poolEnabled` as a product concept. Account supply is controlled by `enabled` and runtime health.

## Product Model

The customer-visible product becomes:

- Product/type: Claude, Codex, Antigravity, or supported combinations.
- Seats: `1`, `2`, `4`, or `8`.
- A seat is one eighth of the account share model. `1` means `1/8`; `2` means `2/8`; `8` means `8/8`.
- Customers never see the assigned upstream account during purchase.

The backend treats a purchase as:

- A fixed customer quota entitlement.
- A preferred initial account for each product.
- A dynamic runtime assignment policy.

## Quota Baselines

New subscriptions store concrete limits at purchase/grant time.

Default baselines:

- Claude: learned `anthropic:max-20x:claude` budget multiplied by `shareSeats / 8`.
- Codex: learned `codex:pro:gpt` budget multiplied by `shareSeats / 8`.
- Antigravity Gemini: fixed Ultra baseline, 5h `100M`, weekly `400M`, multiplied by `shareSeats / 8`.
- Antigravity Claude/Opus: fixed Ultra baseline, 5h `12M`, weekly `40M`, multiplied by `shareSeats / 8`.

Learning remains an internal recommendation source. It must not make an active customer's displayed quota float up and down. A purchased subscription stores the computed token limits and remains stable for that subscription period.

Antigravity is fixed because current Ultra learning data is not reliable enough for customer-facing quota generation.

## Subscription Config

New unified bind subscriptions should use a config shape like:

```json
{
  "line": "bind",
  "products": ["anthropic"],
  "levels": {
    "anthropic": "max-20x"
  },
  "shareSeats": 2,
  "shareCapacity": 8,
  "bucketLimits": {
    "anthropic-claude": 20000000
  },
  "weeklyBucketLimits": {
    "anthropic-claude": 100000000
  },
  "displayBindings": {
    "anthropic": 12
  },
  "assignmentPolicy": "preferred-dynamic",
  "deviceLimit": 1,
  "windowMs": 18000000
}
```

Field semantics:

- `products`: customer entitlement.
- `levels`: purchase baseline and same-level scheduling preference.
- `shareSeats`: customer purchased seats, one seat equals `1/8`.
- `shareCapacity`: denominator for display and quota calculation, default `8`.
- `bucketLimits`: fixed customer 5h limits per composite bucket.
- `weeklyBucketLimits`: fixed customer weekly limits per composite bucket.
- `displayBindings`: preferred initial account per product.
- `assignmentPolicy: "preferred-dynamic"`: try the preferred account first, then dynamically fallback.

`bindings` remains a legacy mirror during migration, but new logic must not treat it as "pin this subscription to one account" when `assignmentPolicy` is `preferred-dynamic`.

`weeklyTokenLimit` remains only for compatibility with old cards and old code paths. New catalog purchases and grants use `weeklyBucketLimits`.

## Admin Capacity Rules

`poolEnabled` is retired. All `enabled=true` accounts are part of dynamic supply. Old `poolEnabled=false` data is ignored after migration. To remove an account from supply, an operator sets `enabled=false`.

Admin capacity should be configured in one unified entry point, with rows or sections for product/baseline combinations:

- Product.
- Baseline level, for example Claude `max-20x`, Codex `pro`, Antigravity `ultra`.
- Quota source: `learned` or `fixed`.
- Fixed 5h and weekly bucket values where applicable.
- Per-account sellable seats.
- Allowed customer seats: fixed to `1`, `2`, `4`, `8`.
- Dynamic supply enabled by default.

Sellable seat capacity is counted in `1/8` units:

- Config value `10` means the account can be the preferred/display account for up to ten `1/8` seats.
- A `2/8` subscription consumes `2` seats.
- An `8/8` subscription consumes `8` seats.

During purchase/grant, the selected preferred account must have:

- `enabled !== false`.
- Basic provider eligibility, such as token presence and project id where required.
- Remaining sellable seats greater than or equal to the purchased `shareSeats`.
- Preferably current quota health.

Seat accounting for sales uses ACTIVE subscriptions and their `displayBindings`. Runtime fallback is not constrained by sellable seats; it only cares about current account health and quota.

## Purchase And Grant Flow

Customer purchase:

1. Customer selects product/type and `1`, `2`, `4`, or `8` seats.
2. Server computes concrete `bucketLimits` and `weeklyBucketLimits`.
3. Server chooses a preferred/display account per product.
4. Preferred selection first looks for the baseline level, then may cross levels if needed.
5. Account must have remaining sellable seats `>= shareSeats`.
6. Among candidates, prefer healthier quota and lower operational risk.
7. Server writes the subscription config and mirrors legacy columns as needed.

If no preferred account can be assigned for a product before payment, the purchase should be blocked rather than creating an unbound subscription. Admin grant should use the same precheck, with an explicit force/manual path only if operators accept the risk.

## Lease Scheduling

For every lease request:

1. Resolve the subscription and verify it covers the requested product.
2. Enforce customer-level `bucketLimits` for the request bucket.
3. Enforce customer-level `weeklyBucketLimits` for the request bucket.
4. Read `displayBindings[product]` as the preferred account.
5. If the preferred account is enabled, eligible, healthy, and has quota for the request bucket, use it.
6. If not, search same-level accounts for the product.
7. If none are available, search all enabled accounts for the same product, regardless of level.
8. Sort candidates by the current request bucket's remaining quota.
9. If no account can serve, return a supply unavailable or retry response.

Candidate ranking:

```text
score = min(remaining5hFraction, remainingWeeklyFraction)
```

Use the current bucket only. For example, a Claude request ranks on `anthropic-claude`, a Codex request ranks on `codex-gpt`, and Antigravity model requests rank on their corresponding `antigravity-*` bucket.

When reliable weekly account data is missing, rank by 5h only. Do not invent account-level weekly data for ranking. Customer weekly entitlement is still enforced by `weeklyBucketLimits`.

Cross-level fallback is allowed. Level only affects preference order; it is not a hard runtime gate once the customer entitlement is already fixed.

## Server Response Semantics

The response should keep backward compatibility where possible, but the meaning for dynamic bind subscriptions changes:

- The runtime account is the actual current service account.
- The preferred/display account is not necessarily the runtime account.
- The client should be allowed to rotate/re-lease on runtime failures.

Recommended response shape:

```json
{
  "bound": false,
  "displayBound": true,
  "accountId": 205,
  "emailHint": "cu***@example.com",
  "planType": "pro",
  "serviceAccount": {
    "accountId": 205,
    "emailHint": "cu***@example.com",
    "planType": "pro"
  },
  "accessKeyStatus": {
    "quotaMode": "static",
    "products": ["codex"],
    "buckets": [],
    "weeklyBuckets": []
  },
  "accountBuckets": {}
}
```

For `preferred-dynamic`, `bound` should not mean "no other account can be used." Existing client retry logic uses `bound` to disable rotation, so dynamic bind responses should not set `bound=true` for that purpose.

## Client Display

The desktop client should show two blood-bar perspectives:

```text
Claude · 2/8 seats

My seats
5h  [blood bar]
Week [blood bar]

Current service account
5h  [blood bar]
Week [blood bar when available]
```

Rules:

- Do not show exact token counts in the main quota bars.
- "My seats" uses only the subscription's fixed customer quota and this card's usage.
- "My seats" is stable. Other customers, learning changes, preferred account depletion, and fallback account changes do not move it.
- "Current service account" uses the actual account returned by the latest lease.
- If runtime fallback changes accounts, the current service account identity and account blood bars may change together.
- Rename the old "bound account info" panel to "Current service account" or equivalent wording.
- Do not show the implementation detail that this account is a fallback.
- Do not expose the preferred/display account as a promise that the account never changes.

This is intentionally more direct than a virtual account blood bar. A virtual bar would hide switching but creates contradictions when a real account is empty while the customer can still use another account. Showing the current lease account avoids that contradiction.

The customer still sees a bound-line product through the seat label and stable purchased quota:

```text
Claude · 2/8 seats
```

The client must also fix status synchronization:

- Codex-only and Claude-only paths must propagate `accessKeyStatus` into the unified local state.
- Static quota display must work even when the main Antigravity leaser does not run.
- `accountFractions` / `accountBuckets` are current service account data, not customer entitlement data.

## Customer Portal

The web portal should align with the client:

- Show products and seats.
- Show quota bars from `bucketLimits` and `weeklyBucketLimits`.
- Do not expose backend overbooking or fallback assignment.
- Do not show raw account ids as a customer entitlement.
- Historical subscriptions may show "legacy package" and an approximate seat label.

## Legacy Card Migration

Legacy card entitlements are preserved. Migration must not recalculate old quotas from the new baseline.

Pool/static legacy cards:

- Preserve existing `bucketLimits`.
- Populate `weeklyBucketLimits` only when an equivalent old weekly limit is known or can be mapped without changing entitlement.
- Keep old `weeklyTokenLimit` for compatibility.
- Convert to unified bind semantics with `assignmentPolicy: "preferred-dynamic"` when possible.
- Assign a preferred/display account for the supported products when seat capacity permits.

Legacy bind cards:

- Preserve existing bound account as `displayBindings`.
- Preserve existing quota and usage state.
- Move runtime behavior to preferred-dynamic if the card is eligible for unified behavior.

Legacy display seat label:

- Use real 5h quota, ignoring placeholder caps such as `1`.
- `<= 8M` displays as `1` seat.
- `> 8M && <= 16M` displays as `2` seats.
- `> 16M && <= 32M` displays as `4` seats.
- `> 32M` displays as `8` seats.

For multi-product cards, preserve per-product limits and show a legacy package label rather than pretending the old package exactly matches a new catalog SKU.

## Important Code Areas

Likely affected modules:

- `apps/server/src/leasing/plan-catalog/pricing.ts`
- `apps/server/src/leasing/subscription/subscription-config.ts`
- `apps/server/src/leasing/subscription/entitlement-sync.service.ts`
- `apps/server/src/leasing/subscription/seat.ts`
- `apps/server/src/leasing/lease-core/lease-service.ts`
- `apps/server/src/leasing/lease-core/subscription-scheduler.ts`
- `apps/server/src/leasing/token-server/access-key-store.ts`
- `apps/server/src/leasing/token-server/token-billing.ts`
- `apps/server/src/leasing/account/portal/portal.service.ts`
- `apps/server/src/leasing/account/card-migration/card-migration.service.ts`
- `apps/web/src/components/account/catalog-purchase.tsx`
- `apps/web/src/app/(console)/console/(dashboard)/(product)/plan-catalog/*`
- `apps/web/src/app/(console)/console/(dashboard)/(customer)/*`
- `apps/app/frontend/src/pages/DashboardPage.tsx`
- `apps/app/frontend/src/components/BoundAccountsCard.tsx`
- `apps/app/leaser.go`
- `apps/app/codex_leaser.go`
- `apps/app/claude_leaser.go`
- `apps/app/leaser_status.go`

## Error Handling

Customer quota exhausted:

- Return a quota exhausted response tied to the customer's card quota.
- Include reset information from the card-level 5h or weekly window.

Preferred account exhausted:

- Do not expose this as a customer quota error.
- Try dynamic fallback.

All supply exhausted:

- Return a supply unavailable or retryable account capacity response.
- The client should message this as service recovery, not as "your card is out of quota."

Account auth or permanent account failure:

- Mark account unhealthy according to existing runtime health logic.
- Dynamic bind subscriptions should seek another account before surfacing the problem.

Missing weekly account data:

- Do not rank by a fabricated weekly account value.
- Continue enforcing the customer's `weeklyBucketLimits`.

## Migration And Rollout

Suggested rollout:

1. Add `weeklyBucketLimits` support to record validation and public status.
2. Add config parsing for `shareSeats`, `shareCapacity`, `displayBindings`, and `assignmentPolicy`.
3. Add admin capacity configuration and sales-seat accounting.
4. Change catalog purchase/grant generation to create unified bind configs with concrete limits.
5. Change lease scheduling to preferred-dynamic.
6. Update client display to "My seats" and "Current service account."
7. Migrate legacy cards and subscriptions.
8. Retire `poolEnabled` UI and runtime filtering.

The rollout should keep old subscriptions working while new subscriptions use the new config shape. Once migration is complete and validated, old pool-line purchase UI can be removed.

## Testing

Server tests:

- Pricing computes concrete `bucketLimits` and `weeklyBucketLimits` for `1`, `2`, `4`, and `8` seats.
- Antigravity fixed baselines generate the expected 5h and weekly limits.
- Learned Claude/Codex baselines are snapshotted into config and do not change existing subscriptions when profiles later change.
- Purchase blocks when no account has remaining sellable seats `>= shareSeats`.
- Sales-seat accounting counts ACTIVE subscriptions by `displayBindings`.
- Runtime first tries the preferred account.
- Runtime falls back to same-level accounts when preferred account has no quota.
- Runtime falls back cross-level when same-level accounts are unavailable.
- Candidate ranking uses `min(5h, weekly)` when both are known.
- `weeklyBucketLimits` enforce per-bucket weekly limits.
- `weeklyTokenLimit` compatibility remains for legacy records.
- `poolEnabled=false` no longer excludes an otherwise enabled account.

Client tests:

- Static "My seats" bars render from card buckets and weekly buckets without exact token text in the main display.
- Current service account bars update when the lease account changes.
- Codex-only and Claude-only subscriptions update unified `accessKeyStatus`.
- The old bound-account panel wording is removed or renamed.
- The footer does not expose confusing raw account identity as an entitlement.

Migration tests:

- Old static cards preserve `bucketLimits`.
- Old weekly settings are not lost.
- Old seat labels map by 8M thresholds.
- Existing usage windows are preserved.
- Existing bound cards keep the original account as preferred/display binding.

## Open Decisions Already Resolved

- Cross-level fallback is allowed.
- Customer purchase seats are only `1`, `2`, `4`, `8`.
- Overbooking configuration is in seat units, not "cars."
- `poolEnabled` is retired; `enabled` is authoritative.
- Client displays the current lease's real service account, not a virtual account and not necessarily the first preferred account.
