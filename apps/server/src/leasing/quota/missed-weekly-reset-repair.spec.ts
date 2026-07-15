import { describe, expect, it } from "vitest";

import { createWindowState, type QuotaWindowsState } from "./fair-share-window";
import {
  buildHourlyRepairUsage,
  checkPersistedUsageCoverage,
  matchPersistedUsageEventsToLogs,
  isRepairLogInBucket,
  parseRepairArgs,
  parseRepairExport,
  parsePersistedUsageEvents,
  parseExportUtc,
  reconstructMissedWeeklyReset,
  type MissedResetCandidate,
} from "./missed-weekly-reset-repair";

const RESET_OBSERVED_AT = Date.parse("2026-07-13T04:38:27.708Z");
const NEW_RESET_AT = Date.parse("2026-07-20T00:06:05.000Z");

function candidate(overrides: Partial<MissedResetCandidate> = {}): MissedResetCandidate {
  return {
    provider: "codex",
    accountId: 19,
    accountEmail: "cavenessmon00@hotmail.com",
    modelKey: "codex",
    bucket: "codex-gpt",
    scope: "weekly",
    missedResetObservedUtc: new Date(RESET_OBSERVED_AT).toISOString(),
    oldPercent: 72,
    newPercent: 86,
    oldResetAtUtc: "2026-07-18T06:02:35.000Z",
    newResetAtUtc: new Date(NEW_RESET_AT).toISOString(),
    headRevision: 14352,
    currentPercent: 74,
    currentResetAtUtc: new Date(NEW_RESET_AT).toISOString(),
    totalCu: 818.2532673,
    totalCarried: 0.075555555556,
    totalAttributed: 0.184444444444,
    assignedBurn: 0.184444444444,
    unattributedShare: 0,
    headUpdatedAt: "2026-07-13T08:10:48.000Z",
    ...overrides,
  };
}

function corruptedWindows(): QuotaWindowsState {
  const subjects = [
    { quotaSubjectId: "card-a", share: 0.2, exclusive: false },
    { quotaSubjectId: "card-b", share: 0.8, exclusive: false },
  ];
  const primary = createWindowState({ scope: "primary", windowMs: 5 * 60 * 60 * 1000, subjects });
  const weekly = createWindowState({ scope: "weekly", windowMs: 7 * 24 * 60 * 60 * 1000, subjects });
  weekly.primed = true;
  weekly.resetAt = NEW_RESET_AT;
  weekly.windowStart = NEW_RESET_AT - weekly.windowMs;
  weekly.fraction = 0.74;
  weekly.lastSnapshotAt = RESET_OBSERVED_AT + 20_000;
  weekly.revision = 14352;
  weekly.assignedBurn = 0.184444444444;
  weekly.subjects["card-a"].cumulativeCu = 300;
  weekly.subjects["card-a"].carriedAttributedShare = 0.075555555556;
  weekly.subjects["card-a"].attributedShare = 0.08;
  weekly.subjects["card-b"].cumulativeCu = 518.2532673;
  weekly.subjects["card-b"].attributedShare = 0.104444444444;
  return { primary, weekly };
}

describe("missed weekly reset repair", () => {
  it("treats export timestamps without a suffix as UTC", () => {
    expect(parseExportUtc("2026-07-13 04:38:27"))
      .toBe(Date.parse("2026-07-13T04:38:27.000Z"));
  });

  it("defaults to dry-run and requires an input path", () => {
    expect(parseRepairArgs(["--input=exports/repair.json"])).toEqual({
      apply: false,
      inputPath: "exports/repair.json",
    });
    expect(parseRepairArgs(["--input=exports/repair.json", "--apply"])).toEqual({
      apply: true,
      inputPath: "exports/repair.json",
    });
    expect(() => parseRepairArgs([])).toThrow("MISSING_INPUT");
  });

  it("selects only live Codex weekly candidates from the export", () => {
    const selected = parseRepairExport({
      candidates: [
        candidate(),
        candidate({ scope: "primary" }),
        candidate({ accountId: 28, headRevision: null, currentPercent: null, currentResetAtUtc: null }),
        candidate({ accountId: 99, provider: "anthropic" }),
      ],
    });

    expect(selected.map((value) => value.accountId)).toEqual([19]);
  });

  it("keeps only post-reset Codex GPT events and restores net token fields", () => {
    const events = parsePersistedUsageEvents({
      quotaSubjectId: "card-a",
      bucket: "codex-gpt",
      missedResetAt: RESET_OBSERVED_AT,
      windowState: JSON.stringify({
        weeklyTokenUsageEvents: [
          {
            at: RESET_OBSERVED_AT - 1,
            inputTokens: 10,
            outputTokens: 0,
            cachedInputTokens: 0,
            modelKey: "gpt-5",
            product: "codex",
          },
          {
            at: RESET_OBSERVED_AT + 1,
            inputTokens: 100,
            outputTokens: 5,
            cachedInputTokens: 40,
            modelKey: "gpt-5",
            product: "codex",
            serviceTier: "priority",
          },
          {
            at: RESET_OBSERVED_AT + 2,
            inputTokens: 100,
            outputTokens: 5,
            cachedInputTokens: 0,
            modelKey: "claude-sonnet-4-6",
            product: "anthropic",
          },
        ],
      }),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      quotaSubjectId: "card-a",
      inputTokens: 60,
      cachedInputTokens: 40,
      outputTokens: 5,
      serviceTier: "fast",
      occurredAt: RESET_OBSERVED_AT + 1,
    });
  });

  it("uses the request log completion time instead of the later persistence time", () => {
    const matched = matchPersistedUsageEventsToLogs([
      {
        quotaSubjectId: "card-a",
        occurredAt: RESET_OBSERVED_AT + 1_000,
        modelId: "gpt-5",
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 5,
        serviceTier: "standard",
      },
    ], [
      {
        id: "log-a",
        quotaSubjectId: "card-a",
        at: RESET_OBSERVED_AT + 1_001,
        upstreamCompletedAt: RESET_OBSERVED_AT - 100,
        modelId: "gpt-5",
        reportId: "report-a",
      },
    ]);

    expect(matched[0].occurredAt).toBe(RESET_OBSERVED_AT - 100);
    expect(matched[0].sourceLogId).toBe("log-a");
    expect(() => matchPersistedUsageEventsToLogs(matched, [])).toThrow("REQUEST_LOG_MATCH_MISSING");
  });

  it("matches legacy logs without completion time only beyond the reset safety margin", () => {
    const event = {
      quotaSubjectId: "card-a",
      occurredAt: RESET_OBSERVED_AT + 120_000,
      modelId: "gpt-5",
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 5,
      totalTokens: 105,
      serviceTier: "standard" as const,
    };
    const log = {
      id: "legacy-log",
      quotaSubjectId: "card-a",
      at: event.occurredAt + 1,
      requestStartedAt: 0,
      upstreamCompletedAt: 0,
      modelId: "gpt-5",
      reportId: "legacy-report",
      totalTokens: 105,
    };

    expect(matchPersistedUsageEventsToLogs([event], [log], {
      missingCompletionFallbackAfter: RESET_OBSERVED_AT + 60_000,
    })[0]).toMatchObject({ occurredAt: event.occurredAt, sourceLogId: "legacy-log" });
    expect(() => matchPersistedUsageEventsToLogs([
      { ...event, occurredAt: RESET_OBSERVED_AT + 30_000 },
    ], [{ ...log, at: RESET_OBSERVED_AT + 30_001 }], {
      missingCompletionFallbackAfter: RESET_OBSERVED_AT + 60_000,
    })).toThrow("REQUEST_LOG_MATCH_MISSING");
  });

  it("refuses an ambiguous legacy log match", () => {
    const event = {
      quotaSubjectId: "card-a",
      occurredAt: RESET_OBSERVED_AT + 120_000,
      modelId: "gpt-5",
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 5,
      totalTokens: 105,
      serviceTier: "standard" as const,
    };
    const log = {
      quotaSubjectId: "card-a",
      at: event.occurredAt + 1,
      requestStartedAt: 0,
      upstreamCompletedAt: 0,
      modelId: "gpt-5",
      reportId: "legacy-report",
      totalTokens: 105,
    };

    expect(() => matchPersistedUsageEventsToLogs([event], [
      { ...log, id: "log-a" },
      { ...log, id: "log-b", at: event.occurredAt + 2 },
    ], { missingCompletionFallbackAfter: RESET_OBSERVED_AT + 60_000 }))
      .toThrow("REQUEST_LOG_MATCH_AMBIGUOUS");
  });

  it("filters completeness logs by the repair bucket", () => {
    expect(isRepairLogInBucket("codex", "codex-gpt", "gpt-5")).toBe(true);
    expect(isRepairLogInBucket("codex", "codex-gpt", "claude-sonnet-4-6")).toBe(false);
  });

  it("checks persisted usage completeness by subject and model counts", () => {
    const event = {
      quotaSubjectId: "card-a", occurredAt: RESET_OBSERVED_AT + 120_000, modelId: "gpt-5",
      inputTokens: 100, cachedInputTokens: 0, outputTokens: 5, serviceTier: "standard" as const,
    };
    const log = {
      id: "log-a", quotaSubjectId: "card-a", at: RESET_OBSERVED_AT + 121_000,
      upstreamCompletedAt: RESET_OBSERVED_AT + 120_500, modelId: "gpt-5", reportId: "r-a", totalTokens: 105,
    };
    const safeAfter = RESET_OBSERVED_AT + 60_000;

    expect(checkPersistedUsageCoverage([event], [log], safeAfter)).toEqual({ ok: true });
    expect(checkPersistedUsageCoverage([event], [log, { ...log, id: "log-b" }], safeAfter))
      .toMatchObject({ ok: false, reason: "PERSISTED_USAGE_INCOMPLETE" });
    expect(checkPersistedUsageCoverage([{ ...event, occurredAt: RESET_OBSERVED_AT + 30_000 }], [], safeAfter))
      .toMatchObject({ ok: false, reason: "PERSISTED_USAGE_NEAR_RESET" });
  });

  it("uses exact reset-hour events, full later hours, and leaves reset-hour residual unknown", () => {
    const result = buildHourlyRepairUsage({
      missedResetAt: RESET_OBSERVED_AT,
      resetHourEvents: [{
        quotaSubjectId: "card-a", occurredAt: RESET_OBSERVED_AT + 1_000, modelId: "gpt-5",
        inputTokens: 100, cachedInputTokens: 0, outputTokens: 0, serviceTier: "standard",
      }],
      hourlyUsage: [
        {
          hourStart: Math.floor(RESET_OBSERVED_AT / 3_600_000) * 3_600_000,
          quotaSubjectId: "card-a", modelId: "gpt-5", inputTokens: 200, cachedInputTokens: 0,
          cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 0, totalTokens: 200, priorityTokens: 0,
        },
        {
          hourStart: Math.ceil(RESET_OBSERVED_AT / 3_600_000) * 3_600_000,
          quotaSubjectId: "card-a", modelId: "gpt-5", inputTokens: 300, cachedInputTokens: 0,
          cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 0, totalTokens: 300, priorityTokens: 0,
        },
      ],
    });

    expect(result.usage).toHaveLength(2);
    expect(result.unknownCu).toBeGreaterThan(0);
  });

  it("removes account 19 old baseline burn while preserving post-reset usage", () => {
    const current = corruptedWindows();
    const result = reconstructMissedWeeklyReset({
      candidate: candidate(),
      current,
      snapshots: [
        {
          id: "new-window",
          observedAt: RESET_OBSERVED_AT,
          fraction: 0.86,
          resetAt: NEW_RESET_AT,
        },
        {
          id: "current-watermark",
          observedAt: RESET_OBSERVED_AT + 20_000,
          fraction: 0.74,
          resetAt: NEW_RESET_AT,
        },
      ],
      usageEvents: [
        {
          quotaSubjectId: "card-a",
          occurredAt: RESET_OBSERVED_AT + 10_000,
          modelId: "gpt-5",
          inputTokens: 1_000_000,
          cachedInputTokens: 0,
          outputTokens: 0,
          serviceTier: "standard",
        },
        {
          quotaSubjectId: "card-b",
          occurredAt: RESET_OBSERVED_AT + 11_000,
          modelId: "gpt-5",
          inputTokens: 2_000_000,
          cachedInputTokens: 0,
          outputTokens: 0,
          serviceTier: "standard",
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.windows.primary).toBe(current.primary);
    expect(result.windows.weekly.fraction).toBeCloseTo(0.74, 12);
    expect(result.windows.weekly.assignedBurn).toBeCloseTo(0.12, 12);
    expect(Object.values(result.windows.weekly.subjects)
      .reduce((sum, subject) => sum + subject.carriedAttributedShare, 0)).toBe(0);
    expect(Object.values(result.windows.weekly.subjects)
      .reduce((sum, subject) => sum + subject.cumulativeCu, 0)).toBeCloseTo(15, 12);
    expect(result.windows.weekly.revision).toBeGreaterThan(current.weekly.revision);
  });

  it("refuses to touch a head whose reset boundary changed", () => {
    const current = corruptedWindows();
    current.weekly.resetAt += 60 * 60 * 1000;
    const result = reconstructMissedWeeklyReset({
      candidate: candidate(),
      current,
      snapshots: [],
      usageEvents: [],
    });

    expect(result).toEqual({ ok: false, reason: "CURRENT_RESET_BOUNDARY_CHANGED" });
  });
});
