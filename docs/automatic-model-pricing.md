# Automatic reference pricing

Model token amounts use the same server-managed models.dev price catalog. This is reference API value, not the private upstream's cash invoice. Subscription prices, mother-account selection, quota reset windows and product entitlement remain independent.

- `PricingService` loads the last successful snapshot from `SiteSetting.automatic_model_pricing_v1`, fetches `https://models.dev/api.json` at startup when stale, then every six hours.
- Only Anthropic, OpenAI and Google vendor catalogs are imported. Reseller prices are not mixed into the reference table. Empty/invalid catalogs and zero-price placeholders cannot replace a valid price. Network/persistence failures retain the previous snapshot.
- Input, output, cache read/write, separately published fast-mode costs and context tiers are normalized. Anthropic 1-hour creation uses its 2× input rule; `cache_write` is the 5-minute price. Each mode uses its own published tiers (an untiered mode is flat).
- Unknown models/modes trigger a coalesced refresh (five-minute cooldown), then admission fails if still unpriced. There is no cross-model flagship fallback. Existing model names are not guessed into new variants.
- Every changed catalog receives a content hash and activation timestamp; historical snapshots remain stored. New requests use occurrence-time prices. Claude stores the version, mode and frozen amount in `GatewayUsage`; durable mother-account reports also store version/amount in `QuotaReportReceipt`. Hourly totals add frozen amounts rather than repricing them.
- The desktop downloads the same snapshots through `GET /api/pricing/snapshot`, caches them per server, and retains the cache offline. Dashboard amounts come from the server ledger. Existing local amounts are not recalculated when the price version changes.
- The bundled table and old family estimates are compatibility data for historical records that predate automatic pricing, not a manually maintained live rate source. On a first deployment without a cached catalog, known bundled models remain usable if the price source is unavailable; unknown models remain closed.

Apply migration `20261102090000_gateway_pricing_version` before starting the new server. It only adds billing provenance fields; it does not alter balances, existing amounts or subscriptions. No operator/API secrets are sent to models.dev or included in the public price endpoint.

Validation covers snapshot activation/history, cache TTL categories, independent fast/context pricing, missing-price refusal, offline recovery, persistence failure, ledger transactions and native desktop cache loading. Model inference availability is separate: upstream admission errors (including calibration 429) are not fixed by price synchronization.
