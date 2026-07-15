import { calculateApiValue, type QuotaProvider } from "@gfa/shared";

export type UsdQuotaRecord = {
  quotaAlgorithm?: string;
  usdQuotaByProduct?: Record<string, { fiveHour?: number; weekly?: number }>;
  usdLimit5h?: number;
  usdLimitWeekly?: number;
  usdQuotaProducts?: unknown;
  tokenUsageEvents?: any[];
  weeklyTokenUsageEvents?: any[];
};

export function usdQuotaLimit(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function usesUsdQuota(record: UsdQuotaRecord | null | undefined): boolean {
  return record?.quotaAlgorithm === "usd"
    || Object.values(record?.usdQuotaByProduct || {}).some(
      (quota) => usdQuotaLimit(quota?.fiveHour) > 0 || usdQuotaLimit(quota?.weekly) > 0,
    )
    || usdQuotaLimit(record?.usdLimit5h) > 0
    || usdQuotaLimit(record?.usdLimitWeekly) > 0;
}

export function supportsApiUsdProduct(product: unknown): boolean {
  const normalized = String(product || "").trim().toLowerCase();
  return normalized === "codex" || normalized === "anthropic";
}

/** Product-scoped gate. Older USD records did not carry usdQuotaProducts, so
 * they retain the historical behavior for supported products only. */
export function usesUsdQuotaForProduct(
  record: UsdQuotaRecord | null | undefined,
  product: unknown,
): boolean {
  const normalized = String(product || "").trim().toLowerCase();
  if (!supportsApiUsdProduct(normalized) || !usesUsdQuota(record)) return false;
  if (record?.usdQuotaByProduct && typeof record.usdQuotaByProduct === "object") {
    const quota = record.usdQuotaByProduct[normalized];
    return usdQuotaLimit(quota?.fiveHour) > 0 || usdQuotaLimit(quota?.weekly) > 0;
  }
  if (!Array.isArray(record?.usdQuotaProducts)) return true;
  return record.usdQuotaProducts.some((value) => String(value || "").trim().toLowerCase() === normalized);
}

export function usdQuotaForProduct(
  record: UsdQuotaRecord | null | undefined,
  product: unknown,
): { fiveHour: number; weekly: number } {
  const normalized = String(product || "").trim().toLowerCase();
  const mapped = record?.usdQuotaByProduct?.[normalized];
  if (mapped) {
    return {
      fiveHour: usdQuotaLimit(mapped.fiveHour),
      weekly: usdQuotaLimit(mapped.weekly),
    };
  }
  if (!usesUsdQuotaForProduct(record, normalized)) return { fiveHour: 0, weekly: 0 };
  return {
    fiveHour: usdQuotaLimit(record?.usdLimit5h),
    weekly: usdQuotaLimit(record?.usdLimitWeekly),
  };
}

function providerForProduct(product: unknown): QuotaProvider | null {
  const normalized = String(product || "").trim().toLowerCase();
  if (supportsApiUsdProduct(normalized)) return normalized as QuotaProvider;
  return null;
}

function nonNegative(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Freeze one usage event into API-equivalent USD. Existing events without a
 * frozen value are still readable: they are valued from their model/tokens at
 * the event timestamp, so enabling a limit mid-window preserves prior usage.
 */
export function apiValueUsdForEvent(event: any): number {
  const frozen = Number(event?.apiValueUsd);
  if (Number.isFinite(frozen) && frozen >= 0) return frozen;

  const provider = providerForProduct(event?.product);
  if (!provider) return 0;
  const grossInput = nonNegative(event?.inputTokens);
  // AccessKeyStore first normalizes every provider to one canonical gross-input
  // event: cached reads and cache creation are subsets of inputTokens. This keeps
  // historical window events and the frozen hourly value on the same basis.
  const cachedInputTokens = Math.min(grossInput, nonNegative(event?.cachedInputTokens));
  const cacheWrite5mTokens = Math.min(
    Math.max(0, grossInput - cachedInputTokens),
    nonNegative(event?.cacheWrite5mTokens ?? event?.cacheCreationTokens),
  );
  const cacheWrite1hTokens = Math.min(
    Math.max(0, grossInput - cachedInputTokens - cacheWrite5mTokens),
    nonNegative(event?.cacheWrite1hTokens),
  );
  const inputTokens = Math.max(0, grossInput - cachedInputTokens - cacheWrite5mTokens - cacheWrite1hTokens);
  return calculateApiValue({
      provider,
      modelId: String(event?.modelKey || ""),
      pricingMode: String(event?.serviceTier || "") === "priority" ? "priority" : "standard",
      inputTokens,
      cachedInputTokens,
      cacheWrite5mTokens,
      cacheWrite1hTokens,
      outputTokens: nonNegative(event?.outputTokens),
      contextTokens: nonNegative(event?.contextTokens),
      occurredAt: nonNegative(event?.occurredAt ?? event?.at) || Date.now(),
  }).usd;
}

export function apiValueUsdForEvents(events: unknown): number {
  if (!Array.isArray(events)) return 0;
  return events.reduce((sum, event) => sum + apiValueUsdForEvent(event), 0);
}

function frozenTotal(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function usedUsd5h(record: UsdQuotaRecord & { usdUsed5h?: number }): number {
  return frozenTotal(record?.usdUsed5h) ?? apiValueUsdForEvents(record?.tokenUsageEvents);
}

export function usedUsdWeekly(record: UsdQuotaRecord & { usdUsedWeekly?: number }): number {
  return frozenTotal(record?.usdUsedWeekly) ?? apiValueUsdForEvents(record?.weeklyTokenUsageEvents);
}
