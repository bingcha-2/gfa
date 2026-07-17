export type AnthropicRefillRepairResult = {
  windowState: string;
  oldUsedWeekly: number;
  newUsedWeekly: number;
  eventId: string;
};

function parseObject(raw: string | null | undefined): Record<string, any> {
  if (!String(raw || "").trim()) return {};
  const parsed = JSON.parse(String(raw));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("INVALID_WINDOW_STATE");
  }
  return parsed;
}

export function nextUtcHour(timestamp: number): number {
  const hour = 3_600_000;
  return Math.ceil(timestamp / hour) * hour;
}

/** Rebuild only the Anthropic weekly personal-USD window after a proven refill. */
export function repairAnthropicWeeklyWindow(input: {
  rawWindowState: string | null | undefined;
  accountId: number;
  resetObservedAt: number;
  rebuiltUsedWeekly: number;
}): AnthropicRefillRepairResult {
  const state = parseObject(input.rawWindowState);
  const byProduct = state.usdUsageByProduct && typeof state.usdUsageByProduct === "object"
    && !Array.isArray(state.usdUsageByProduct)
    ? { ...state.usdUsageByProduct }
    : {};
  const current = byProduct.anthropic && typeof byProduct.anthropic === "object"
    && !Array.isArray(byProduct.anthropic)
    ? { ...byProduct.anthropic }
    : {};
  const upstreamWeekly = current.upstreamWeekly && typeof current.upstreamWeekly === "object"
    && !Array.isArray(current.upstreamWeekly)
    ? { ...current.upstreamWeekly }
    : {};
  const oldUsedWeekly = Math.max(0, Number(current.usedWeekly ?? state.usdUsedWeekly) || 0);
  const newUsedWeekly = Math.max(0, Number(input.rebuiltUsedWeekly) || 0);
  const eventId = `repair:anthropic:${input.accountId}:weekly:${input.resetObservedAt}`;

  delete upstreamWeekly.reboundCandidateCount;
  byProduct.anthropic = {
    ...current,
    usedWeekly: newUsedWeekly,
    windowStartedAtWeekly: input.resetObservedAt,
    upstreamAccountId: input.accountId,
    upstreamWeekly: {
      ...upstreamWeekly,
      observedAt: input.resetObservedAt,
      lastSnapshotId: eventId,
      appliedResetEventId: eventId,
    },
  };
  state.usdUsageByProduct = byProduct;

  return { windowState: JSON.stringify(state), oldUsedWeekly, newUsedWeekly, eventId };
}
