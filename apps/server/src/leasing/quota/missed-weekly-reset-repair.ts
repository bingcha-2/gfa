import { calculateQuotaCu } from "@gfa/shared";

import { bucketKey } from "../lease-core/product-bucket";
import {
  createWindowState,
  reduceWindow,
  type QuotaWindowsState,
  type WindowEvent,
  type WindowSubjectConfig,
} from "./fair-share-window";

const RESET_TOLERANCE_MS = 60_000;
const FRACTION_TOLERANCE = 1e-9;

export interface MissedResetCandidate {
  provider: string;
  accountId: number;
  accountEmail: string;
  modelKey: string;
  bucket: string;
  scope: string;
  missedResetObservedUtc: string;
  oldPercent: number;
  newPercent: number;
  oldResetAtUtc: string;
  newResetAtUtc: string;
  headRevision: number | null;
  currentPercent: number | null;
  currentResetAtUtc: string | null;
  totalCu: number;
  totalCarried: number;
  totalAttributed: number;
  assignedBurn: number;
  unattributedShare: number;
  headUpdatedAt: string | null;
}

export interface RepairSnapshot {
  id: string;
  observedAt: number;
  fraction: number;
  resetAt: number;
}

export interface PersistedRepairUsage {
  quotaSubjectId: string;
  occurredAt: number;
  modelId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  serviceTier: "standard" | "fast";
  totalTokens?: number;
  sourceLogId?: string;
}

export interface RepairRequestLog {
  id: string;
  quotaSubjectId: string;
  at: number;
  requestStartedAt?: number;
  upstreamCompletedAt: number;
  modelId: string;
  reportId: string;
  totalTokens?: number;
}

export interface RepairHourlyUsage {
  hourStart: number;
  quotaSubjectId: string;
  modelId: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  totalTokens: number;
  priorityTokens: number;
}

export interface RepairCuUsage {
  quotaSubjectId: string;
  occurredAt: number;
  cu: number;
}

type RepairFailureReason =
  | "CURRENT_RESET_BOUNDARY_CHANGED"
  | "ALREADY_CLEAN"
  | "START_SNAPSHOT_MISSING"
  | "UNKNOWN_USAGE_SUBJECT"
  | "FINAL_RESET_BOUNDARY_MISMATCH"
  | "FINAL_FRACTION_MISMATCH"
  | "INVALID_USAGE_CU";

export type MissedResetRepairResult =
  | {
      ok: true;
      windows: QuotaWindowsState;
      stats: { usageEvents: number; reconstructedCu: number; unknownCu: number; oldCu: number };
    }
  | { ok: false; reason: RepairFailureReason };

export function parseExportUtc(value: string): number {
  const normalized = String(value || "").trim().replace(" ", "T");
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`;
  return Date.parse(withZone);
}

export function parseRepairArgs(args: string[]): { apply: boolean; inputPath: string } {
  const inputArg = args.find((arg) => arg.startsWith("--input="));
  const inputPath = inputArg?.slice("--input=".length).trim();
  if (!inputPath) throw new Error("MISSING_INPUT");
  return { apply: args.includes("--apply"), inputPath };
}

export function parseRepairExport(value: unknown): MissedResetCandidate[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { candidates?: unknown }).candidates)) {
    throw new Error("INVALID_REPAIR_EXPORT");
  }
  return ((value as { candidates: unknown[] }).candidates as MissedResetCandidate[])
    .filter((candidate) => candidate?.provider === "codex"
      && candidate.bucket === "codex-gpt"
      && candidate.scope === "weekly"
      && Number.isFinite(candidate.accountId)
      && candidate.headRevision != null
      && candidate.currentPercent != null
      && candidate.currentResetAtUtc != null)
    .sort((a, b) => a.accountId - b.accountId);
}

function finiteNonNegative(value: unknown, field: string): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) throw new Error(`INVALID_${field.toUpperCase()}`);
  return number;
}

export function parsePersistedUsageEvents(input: {
  quotaSubjectId: string;
  bucket: string;
  missedResetAt: number;
  windowState: string | null;
}): PersistedRepairUsage[] {
  if (!input.windowState) return [];
  const parsed = JSON.parse(input.windowState) as { weeklyTokenUsageEvents?: unknown };
  if (parsed.weeklyTokenUsageEvents == null) return [];
  if (!Array.isArray(parsed.weeklyTokenUsageEvents)) throw new Error("INVALID_WEEKLY_TOKEN_USAGE_EVENTS");

  const events: PersistedRepairUsage[] = [];
  for (const raw of parsed.weeklyTokenUsageEvents) {
    if (!raw || typeof raw !== "object") throw new Error("INVALID_WEEKLY_TOKEN_USAGE_EVENT");
    const event = raw as Record<string, unknown>;
    const occurredAt = finiteNonNegative(event.at, "event_at");
    if (occurredAt < input.missedResetAt) continue;
    const modelId = String(event.modelKey || "");
    const product = String(event.product || "");
    if (bucketKey(product, modelId) !== input.bucket) continue;

    const grossInput = finiteNonNegative(event.inputTokens, "input_tokens");
    const cachedInputTokens = Math.min(grossInput, finiteNonNegative(event.cachedInputTokens, "cached_input_tokens"));
    events.push({
      quotaSubjectId: input.quotaSubjectId,
      occurredAt,
      modelId,
      inputTokens: Math.max(0, grossInput - cachedInputTokens),
      cachedInputTokens,
      outputTokens: finiteNonNegative(event.outputTokens, "output_tokens"),
      serviceTier: String(event.serviceTier || "").toLowerCase() === "priority" ? "fast" : "standard",
      ...(event.totalTokens == null ? {} : { totalTokens: finiteNonNegative(event.totalTokens, "total_tokens") }),
    });
  }
  return events;
}

export function isRepairLogInBucket(provider: string, bucket: string, modelId: string): boolean {
  return bucketKey(provider, modelId) === bucket;
}

export function checkPersistedUsageCoverage(
  events: PersistedRepairUsage[],
  logs: RepairRequestLog[],
  safeAfter: number,
): { ok: true } | {
  ok: false;
  reason: "PERSISTED_USAGE_NEAR_RESET" | "PERSISTED_USAGE_INCOMPLETE";
  groups: Array<{ quotaSubjectId: string; modelId: string; events: number; logs: number }>;
} {
  const nearReset = events.filter((event) => event.occurredAt < safeAfter);
  if (nearReset.length > 0) {
    return {
      ok: false,
      reason: "PERSISTED_USAGE_NEAR_RESET",
      groups: nearReset.map((event) => ({
        quotaSubjectId: event.quotaSubjectId,
        modelId: event.modelId,
        events: 1,
        logs: 0,
      })),
    };
  }

  const keyOf = (quotaSubjectId: string, modelId: string) => `${quotaSubjectId}\u0000${modelId}`;
  const eventCounts = new Map<string, number>();
  for (const event of events) {
    const key = keyOf(event.quotaSubjectId, event.modelId);
    eventCounts.set(key, (eventCounts.get(key) || 0) + 1);
  }
  const logCounts = new Map<string, number>();
  for (const log of logs) {
    if (Number(log.totalTokens) <= 0 || log.at < safeAfter) continue;
    const key = keyOf(log.quotaSubjectId, log.modelId);
    logCounts.set(key, (logCounts.get(key) || 0) + 1);
  }
  const incomplete = [...logCounts.entries()].flatMap(([key, count]) => {
    const eventsInGroup = eventCounts.get(key) || 0;
    if (count <= eventsInGroup) return [];
    const [quotaSubjectId, modelId] = key.split("\u0000");
    return [{ quotaSubjectId, modelId, events: eventsInGroup, logs: count }];
  });
  return incomplete.length > 0
    ? { ok: false, reason: "PERSISTED_USAGE_INCOMPLETE", groups: incomplete }
    : { ok: true };
}

function persistedUsageCu(usage: PersistedRepairUsage): number {
  return calculateQuotaCu({
    provider: "codex",
    modelId: usage.modelId,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: usage.outputTokens,
    serviceTier: usage.serviceTier,
    occurredAt: usage.occurredAt,
  }).cu;
}

function hourlyUsageCu(usage: RepairHourlyUsage): { knownCu: number; upperCu: number } {
  const common = {
    provider: "codex" as const,
    modelId: usage.modelId,
    inputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens
      - usage.cacheWrite5mTokens - usage.cacheWrite1hTokens),
    cachedInputTokens: usage.cachedInputTokens,
    cacheWrite5mTokens: usage.cacheWrite5mTokens,
    cacheWrite1hTokens: usage.cacheWrite1hTokens,
    outputTokens: usage.outputTokens,
    occurredAt: usage.hourStart,
  };
  const standard = calculateQuotaCu({ ...common, serviceTier: "standard" }).cu;
  const fast = calculateQuotaCu({ ...common, serviceTier: "fast" }).cu;
  if (usage.priorityTokens <= 0) return { knownCu: standard, upperCu: standard };
  if (usage.totalTokens > 0 && usage.priorityTokens >= usage.totalTokens) {
    return { knownCu: fast, upperCu: fast };
  }
  // Mixed standard/fast aggregates do not retain which token classes were fast.
  // Keep the provable standard CU on the card and move the possible uplift to unknown.
  return { knownCu: standard, upperCu: fast };
}

export function buildHourlyRepairUsage(input: {
  missedResetAt: number;
  hourlyUsage: RepairHourlyUsage[];
  resetHourEvents: PersistedRepairUsage[];
}): { usage: RepairCuUsage[]; unknownCu: number } {
  const hourMs = 60 * 60 * 1000;
  const resetHour = Math.floor(input.missedResetAt / hourMs) * hourMs;
  const keyOf = (quotaSubjectId: string, modelId: string) => `${quotaSubjectId}\u0000${modelId}`;
  const allResetHourCu = new Map<string, number>();
  const usage: RepairCuUsage[] = [];
  for (const event of input.resetHourEvents) {
    if (event.occurredAt < resetHour || event.occurredAt >= resetHour + hourMs) continue;
    const cu = persistedUsageCu(event);
    const key = keyOf(event.quotaSubjectId, event.modelId);
    allResetHourCu.set(key, (allResetHourCu.get(key) || 0) + cu);
    if (event.occurredAt >= input.missedResetAt && cu > 0) {
      usage.push({ quotaSubjectId: event.quotaSubjectId, occurredAt: event.occurredAt, cu });
    }
  }

  let unknownCu = 0;
  for (const row of input.hourlyUsage) {
    const { knownCu, upperCu } = hourlyUsageCu(row);
    if (!(upperCu > 0)) continue;
    if (row.hourStart === resetHour) {
      unknownCu += Math.max(0, upperCu - (allResetHourCu.get(keyOf(row.quotaSubjectId, row.modelId)) || 0));
      continue;
    }
    if (row.hourStart > resetHour) {
      if (knownCu > 0) usage.push({ quotaSubjectId: row.quotaSubjectId, occurredAt: row.hourStart, cu: knownCu });
      unknownCu += Math.max(0, upperCu - knownCu);
    }
  }
  return { usage, unknownCu };
}

export function matchPersistedUsageEventsToLogs(
  events: PersistedRepairUsage[],
  logs: RepairRequestLog[],
  options: { missingCompletionFallbackAfter?: number } = {},
): PersistedRepairUsage[] {
  const orderedLogs = [...logs].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const used = new Set<string>();
  return [...events].sort((a, b) => a.occurredAt - b.occurredAt).map((event) => {
    const candidates = orderedLogs.filter((log) => !used.has(log.id)
      && log.quotaSubjectId === event.quotaSubjectId
      && log.modelId === event.modelId
      && log.at >= event.occurredAt
      && log.at - event.occurredAt <= 10_000
      && (event.totalTokens == null || log.totalTokens == null || log.totalTokens === event.totalTokens)
      && (log.upstreamCompletedAt > 0
        || Number(log.requestStartedAt) > 0
        || (options.missingCompletionFallbackAfter != null
          && event.occurredAt >= options.missingCompletionFallbackAfter)));
    if (candidates.length > 1) {
      throw new Error(`REQUEST_LOG_MATCH_AMBIGUOUS:${event.quotaSubjectId}:${event.occurredAt}`);
    }
    const match = candidates[0];
    if (!match) throw new Error(`REQUEST_LOG_MATCH_MISSING:${event.quotaSubjectId}:${event.occurredAt}`);
    used.add(match.id);
    const requestStartedAt = Number(match.requestStartedAt);
    const occurredAt = match.upstreamCompletedAt > 0
      ? match.upstreamCompletedAt
      : requestStartedAt > 0 ? Math.min(event.occurredAt, requestStartedAt) : event.occurredAt;
    return { ...event, occurredAt, sourceLogId: match.id };
  });
}

function totalCarried(windows: QuotaWindowsState): number {
  return Object.values(windows.weekly.subjects)
    .reduce((sum, subject) => sum + Math.max(0, subject.carriedAttributedShare), 0);
}

function eventAt(event: WindowEvent): number {
  if (event.kind === "usage") return event.upstreamCompletedAt;
  if (event.kind === "snapshot") return event.observedAt;
  return event.occurredAt;
}

export function reconstructMissedWeeklyReset(input: {
  candidate: MissedResetCandidate;
  current: QuotaWindowsState;
  snapshots: RepairSnapshot[];
  usageEvents?: PersistedRepairUsage[];
  cuUsage?: RepairCuUsage[];
  unknownCu?: number;
}): MissedResetRepairResult {
  const newResetAt = parseExportUtc(input.candidate.newResetAtUtc);
  if (!Number.isFinite(newResetAt)
    || Math.abs(input.current.weekly.resetAt - newResetAt) > RESET_TOLERANCE_MS) {
    return { ok: false, reason: "CURRENT_RESET_BOUNDARY_CHANGED" };
  }
  if (input.candidate.totalCarried > 0 && totalCarried(input.current) <= 1e-12) {
    return { ok: false, reason: "ALREADY_CLEAN" };
  }

  const missedResetAt = parseExportUtc(input.candidate.missedResetObservedUtc);
  const snapshots = [...input.snapshots]
    .filter((snapshot) => snapshot.observedAt >= missedResetAt - RESET_TOLERANCE_MS)
    .sort((a, b) => a.observedAt - b.observedAt || a.id.localeCompare(b.id));
  const startIndex = snapshots.findIndex((snapshot) =>
    Math.abs(snapshot.resetAt - newResetAt) <= RESET_TOLERANCE_MS
    && snapshot.observedAt >= missedResetAt - RESET_TOLERANCE_MS);
  if (startIndex < 0) return { ok: false, reason: "START_SNAPSHOT_MISSING" };
  const replaySnapshots = snapshots.slice(startIndex);

  const allSubjects = Object.values(input.current.weekly.subjects);
  const configs: WindowSubjectConfig[] = allSubjects.map((subject) => ({
    quotaSubjectId: subject.quotaSubjectId,
    share: subject.share,
    exclusive: subject.exclusive,
  }));
  let weekly = createWindowState({
    scope: "weekly",
    windowMs: input.current.weekly.windowMs,
    subjects: configs,
  });

  const events: WindowEvent[] = replaySnapshots.map((snapshot) => ({
    kind: "snapshot" as const,
    snapshotId: `repair-snapshot:${snapshot.id}`,
    fraction: snapshot.fraction,
    resetAt: snapshot.resetAt,
    observedAt: snapshot.observedAt,
    arrivedAt: snapshot.observedAt,
  }));
  let reconstructedCu = 0;
  const usageEvents = input.usageEvents || [];
  const cuUsage = input.cuUsage || [];
  usageEvents.forEach((usage, index) => {
    if (!weekly.subjects[usage.quotaSubjectId]) return;
    const calculated = calculateQuotaCu({
      provider: "codex",
      modelId: usage.modelId,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: usage.outputTokens,
      serviceTier: usage.serviceTier,
      occurredAt: usage.occurredAt,
    });
    if (!Number.isFinite(calculated.cu) || calculated.cu < 0) return;
    reconstructedCu += calculated.cu;
    events.push({
      kind: "usage",
      reportId: `repair-usage:${usage.quotaSubjectId}:${usage.occurredAt}:${index}`,
      quotaSubjectId: usage.quotaSubjectId,
      cu: calculated.cu,
      upstreamCompletedAt: usage.occurredAt,
      arrivedAt: usage.occurredAt,
    });
  });
  cuUsage.forEach((usage, index) => {
    if (!weekly.subjects[usage.quotaSubjectId] || !Number.isFinite(usage.cu) || usage.cu < 0) return;
    reconstructedCu += usage.cu;
    events.push({
      kind: "usage",
      reportId: `repair-hourly:${usage.quotaSubjectId}:${usage.occurredAt}:${index}`,
      quotaSubjectId: usage.quotaSubjectId,
      cu: usage.cu,
      upstreamCompletedAt: usage.occurredAt,
      arrivedAt: usage.occurredAt,
    });
  });
  if ([...usageEvents, ...cuUsage].some((usage) => !weekly.subjects[usage.quotaSubjectId])) {
    return { ok: false, reason: "UNKNOWN_USAGE_SUBJECT" };
  }
  if (!Number.isFinite(reconstructedCu) || reconstructedCu < 0) {
    return { ok: false, reason: "INVALID_USAGE_CU" };
  }

  events.sort((a, b) => {
    const time = eventAt(a) - eventAt(b);
    if (time !== 0) return time;
    if (a.kind === b.kind) return 0;
    return a.kind === "usage" ? -1 : 1;
  });
  for (const event of events) weekly = reduceWindow(weekly, event);

  const lastAt = events.reduce((latest, event) => Math.max(latest, eventAt(event)), missedResetAt);
  weekly = reduceWindow(weekly, {
    kind: "membership",
    membershipId: `repair-membership:${input.candidate.accountId}:${lastAt + 1}`,
    subjects: allSubjects.filter((subject) => subject.active).map((subject) => ({
      quotaSubjectId: subject.quotaSubjectId,
      share: subject.share,
      exclusive: subject.exclusive,
    })),
    occurredAt: lastAt + 1,
    arrivedAt: lastAt + 1,
  });

  const unknownCu = Math.max(0, Number(input.unknownCu) || 0);
  if (unknownCu > 0 && weekly.assignedBurn > 0) {
    const knownRatio = reconstructedCu > 0 ? reconstructedCu / (reconstructedCu + unknownCu) : 0;
    const movedToUnknown = weekly.assignedBurn * (1 - knownRatio);
    weekly.assignedBurn *= knownRatio;
    weekly.unattributedShare += movedToUnknown;
    for (const subject of Object.values(weekly.subjects)) subject.attributedShare *= knownRatio;
  }

  const latestSnapshot = replaySnapshots[replaySnapshots.length - 1];
  if (Math.abs(weekly.resetAt - latestSnapshot.resetAt) > RESET_TOLERANCE_MS) {
    return { ok: false, reason: "FINAL_RESET_BOUNDARY_MISMATCH" };
  }
  if (Math.abs(weekly.fraction - latestSnapshot.fraction) > FRACTION_TOLERANCE
    || Math.abs(weekly.fraction - input.current.weekly.fraction) > FRACTION_TOLERANCE) {
    return { ok: false, reason: "FINAL_FRACTION_MISMATCH" };
  }
  weekly.revision = Math.max(weekly.revision, input.current.weekly.revision + 1);

  return {
    ok: true,
    windows: { primary: input.current.primary, weekly },
    stats: {
      usageEvents: usageEvents.length + cuUsage.length,
      reconstructedCu,
      unknownCu,
      oldCu: Object.values(input.current.weekly.subjects)
        .reduce((sum, subject) => sum + Math.max(0, subject.cumulativeCu), 0),
    },
  };
}
