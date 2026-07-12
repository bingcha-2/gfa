export const REORDER_HORIZON_MS = 10 * 60 * 1000;
export const REORDER_MAX_EVENTS = 128;
export const REORDER_MAX_BYTES = 16 * 1024;

export type QuotaScope = "primary" | "weekly";

export interface WindowSubjectConfig {
  quotaSubjectId: string;
  share: number;
  exclusive?: boolean;
}

export interface WindowSubjectState extends WindowSubjectConfig {
  active: boolean;
  cumulativeCu: number;
  attributedShare: number;
}

export interface UsageCuEvent {
  kind: "usage";
  reportId: string;
  quotaSubjectId: string;
  cu: number;
  upstreamCompletedAt: number;
  arrivedAt: number;
}

export interface SnapshotEvent {
  kind: "snapshot";
  snapshotId: string;
  fraction: number;
  observedAt: number;
  arrivedAt: number;
  resetAt: number;
}

export interface MembershipEvent {
  kind: "membership";
  membershipId: string;
  subjects: WindowSubjectConfig[];
  occurredAt: number;
  arrivedAt: number;
}

export type WindowEvent = UsageCuEvent | SnapshotEvent | MembershipEvent;

interface WindowCoreState {
  scope: QuotaScope;
  windowMs: number;
  primed: boolean;
  windowStart: number;
  resetAt: number;
  fraction: number;
  lastSnapshotAt: number;
  assignedBurn: number;
  unattributedShare: number;
  subjects: Record<string, WindowSubjectState>;
  compactedThroughAt: number;
}

export interface FairShareWindowState extends WindowCoreState {
  revision: number;
  base: WindowCoreState;
  reorderTail: WindowEvent[];
  lastReason?: string;
}

export interface QuotaWindowsState {
  primary: FairShareWindowState;
  weekly: FairShareWindowState;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
const positive = (value: number) => Number.isFinite(value) && value > 0 ? value : 0;

function cloneSubjects(subjects: Record<string, WindowSubjectState>): Record<string, WindowSubjectState> {
  return Object.fromEntries(Object.entries(subjects).map(([id, subject]) => [id, { ...subject }]));
}

function cloneCore(core: WindowCoreState): WindowCoreState {
  return { ...core, subjects: cloneSubjects(core.subjects) };
}

function causalAt(event: WindowEvent): number {
  if (event.kind === "usage") return event.upstreamCompletedAt;
  if (event.kind === "snapshot") return event.observedAt;
  return event.occurredAt;
}

function compareEvents(a: WindowEvent, b: WindowEvent): number {
  const time = causalAt(a) - causalAt(b);
  if (time !== 0) return time;
  if (a.kind !== b.kind) return a.kind === "usage" ? -1 : 1;
  const id = (event: WindowEvent) => event.kind === "usage"
    ? event.reportId
    : event.kind === "snapshot" ? event.snapshotId : event.membershipId;
  const aId = id(a);
  const bId = id(b);
  return aId.localeCompare(bId);
}

function sameEventId(a: WindowEvent, b: WindowEvent): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "usage" && b.kind === "usage") return a.reportId === b.reportId;
  if (a.kind === "snapshot" && b.kind === "snapshot") return a.snapshotId === b.snapshotId;
  return a.kind === "membership" && b.kind === "membership" && a.membershipId === b.membershipId;
}

function totalCu(core: WindowCoreState): number {
  return Object.values(core.subjects).reduce((sum, subject) => sum + positive(subject.cumulativeCu), 0);
}

function recomputeAttribution(core: WindowCoreState): void {
  const sum = totalCu(core);
  for (const subject of Object.values(core.subjects)) {
    subject.attributedShare = sum > 0 ? core.assignedBurn * positive(subject.cumulativeCu) / sum : 0;
  }
}

function resetCore(core: WindowCoreState, event: SnapshotEvent): WindowCoreState {
  const subjects = Object.fromEntries(Object.entries(cloneSubjects(core.subjects)).filter(([, subject]) => subject.active));
  for (const subject of Object.values(subjects)) {
    subject.cumulativeCu = 0;
    subject.attributedShare = 0;
  }
  return {
    ...core,
    primed: true,
    windowStart: event.resetAt - core.windowMs,
    resetAt: event.resetAt,
    fraction: clamp01(event.fraction),
    lastSnapshotAt: event.observedAt,
    assignedBurn: 0,
    unattributedShare: 0,
    subjects,
  };
}

function applyCoreEvent(input: WindowCoreState, event: WindowEvent): WindowCoreState {
  let core = cloneCore(input);
  if (event.kind === "usage") {
    const subject = core.subjects[event.quotaSubjectId];
    if (subject) subject.cumulativeCu += positive(event.cu);
    core.compactedThroughAt = Math.max(core.compactedThroughAt, causalAt(event));
    return core;
  }

  if (event.kind === "membership") {
    const incoming = new Map(event.subjects.map((subject) => [subject.quotaSubjectId, subject]));
    for (const subject of Object.values(core.subjects)) subject.active = incoming.has(subject.quotaSubjectId);
    for (const config of event.subjects) {
      const existing = core.subjects[config.quotaSubjectId];
      core.subjects[config.quotaSubjectId] = existing
        ? { ...existing, ...config, share: clamp01(config.share), active: true }
        : { ...config, share: clamp01(config.share), active: true, cumulativeCu: 0, attributedShare: 0 };
    }
    core.compactedThroughAt = Math.max(core.compactedThroughAt, causalAt(event));
    return core;
  }

  const fraction = clamp01(event.fraction);
  if (!core.primed) {
    core = resetCore(core, { ...event, fraction });
    core.compactedThroughAt = Math.max(core.compactedThroughAt, causalAt(event));
    return core;
  }

  const forwardReset = event.resetAt > core.resetAt + 60_000 && event.observedAt >= core.resetAt;
  if (forwardReset) {
    core = resetCore(core, { ...event, fraction });
    core.compactedThroughAt = Math.max(core.compactedThroughAt, causalAt(event));
    return core;
  }

  const delta = core.fraction - fraction;
  if (delta > 0) {
    if (totalCu(core) > 0) core.assignedBurn += delta;
    else core.unattributedShare += delta;
    recomputeAttribution(core);
  } else if (delta < 0) {
    const recovery = -delta;
    const burned = core.assignedBurn + core.unattributedShare;
    if (burned > 0) {
      const refund = Math.min(recovery, burned);
      core.assignedBurn -= refund * core.assignedBurn / burned;
      core.unattributedShare -= refund * core.unattributedShare / burned;
      if (core.assignedBurn < 1e-15) core.assignedBurn = 0;
      if (core.unattributedShare < 1e-15) core.unattributedShare = 0;
      recomputeAttribution(core);
    }
  }
  core.fraction = fraction;
  core.resetAt = event.resetAt || core.resetAt;
  core.windowStart = core.resetAt - core.windowMs;
  core.lastSnapshotAt = event.observedAt;
  core.compactedThroughAt = Math.max(core.compactedThroughAt, causalAt(event));
  return core;
}

function replay(base: WindowCoreState, tail: WindowEvent[]): WindowCoreState {
  return [...tail].sort(compareEvents).reduce(applyCoreEvent, cloneCore(base));
}

function tailBytes(events: WindowEvent[]): number {
  return Buffer.byteLength(JSON.stringify(events), "utf8");
}

function compact(base: WindowCoreState, tail: WindowEvent[], cutoff: number): {
  base: WindowCoreState;
  tail: WindowEvent[];
} {
  const sorted = [...tail].sort(compareEvents);
  const fold: WindowEvent[] = [];
  const keep: WindowEvent[] = [];
  for (const event of sorted) {
    if (causalAt(event) < cutoff) fold.push(event);
    else keep.push(event);
  }
  let nextBase = fold.reduce(applyCoreEvent, cloneCore(base));
  while (keep.length >= REORDER_MAX_EVENTS || tailBytes(keep) >= REORDER_MAX_BYTES) {
    const oldest = keep.shift();
    if (!oldest) break;
    nextBase = applyCoreEvent(nextBase, oldest);
  }
  return { base: nextBase, tail: keep };
}

export function createWindowState(config: {
  scope: QuotaScope;
  windowMs: number;
  subjects: WindowSubjectConfig[];
}): FairShareWindowState {
  const subjects = Object.fromEntries(config.subjects.map((subject) => [subject.quotaSubjectId, {
    ...subject,
    share: clamp01(subject.share),
    active: true,
    cumulativeCu: 0,
    attributedShare: 0,
  }]));
  const base: WindowCoreState = {
    scope: config.scope,
    windowMs: config.windowMs,
    primed: false,
    windowStart: 0,
    resetAt: 0,
    fraction: 1,
    lastSnapshotAt: 0,
    assignedBurn: 0,
    unattributedShare: 0,
    subjects,
    compactedThroughAt: 0,
  };
  return { ...cloneCore(base), revision: 0, base, reorderTail: [] };
}

export function reduceWindow(state: FairShareWindowState, incoming: WindowEvent): FairShareWindowState {
  if (state.reorderTail.some((event) => sameEventId(event, incoming))) {
    return { ...state, lastReason: "EVENT_DUPLICATE" };
  }
  if (incoming.kind === "snapshot" && state.primed && incoming.observedAt <= state.lastSnapshotAt) {
    return { ...state, lastReason: "SNAPSHOT_STALE_OBSERVED_AT" };
  }

  const cutoff = incoming.arrivedAt - REORDER_HORIZON_MS;
  const compacted = compact(state.base, state.reorderTail, cutoff);
  let event = { ...incoming } as WindowEvent;
  let lastReason: string | undefined;
  const arrivedLateForSnapshot = incoming.kind === "usage" && incoming.upstreamCompletedAt <= state.lastSnapshotAt;

  if (incoming.kind === "usage" && incoming.upstreamCompletedAt <= compacted.base.compactedThroughAt) {
    event = {
      ...incoming,
      upstreamCompletedAt: Math.max(incoming.upstreamCompletedAt, compacted.base.lastSnapshotAt + 1),
    };
    lastReason = "USAGE_EVIDENCE_MISSING";
  } else if (arrivedLateForSnapshot) {
    lastReason = "LATE_USAGE_RECONCILED";
  }

  let tail = [...compacted.tail, event].sort(compareEvents);
  let base = compacted.base;
  while (tail.length > REORDER_MAX_EVENTS || tailBytes(tail) > REORDER_MAX_BYTES) {
    const oldest = tail.shift();
    if (!oldest) break;
    base = applyCoreEvent(base, oldest);
  }
  const materialized = replay(base, tail);
  return {
    ...materialized,
    revision: state.revision + 1,
    base,
    reorderTail: tail,
    lastReason,
  };
}

export function getSubjectQuota(state: FairShareWindowState, quotaSubjectId: string): {
  fraction: number;
  share: number;
  absoluteRemaining: number;
} {
  const subject = state.subjects[quotaSubjectId];
  if (!subject || !subject.active || subject.share <= 0) return { fraction: 0, share: subject?.share || 0, absoluteRemaining: 0 };
  const raw = Math.max(0, subject.share - subject.attributedShare);
  const activeSubjects = Object.values(state.subjects).filter((value) => value.active);
  const rawTotal = activeSubjects
    .reduce((sum, value) => sum + Math.max(0, value.share - value.attributedShare), 0);
  // Exclusive changes allocation ownership, never conservation: even one sole
  // exclusive card cannot expose more absolute quota than the mother has left.
  const scale = rawTotal > state.fraction ? state.fraction / rawTotal : 1;
  const absoluteRemaining = raw * scale;
  return {
    fraction: clamp01(absoluteRemaining / subject.share),
    share: subject.share,
    absoluteRemaining,
  };
}

export function createQuotaWindows(config: {
  subjects: WindowSubjectConfig[];
  primaryWindowMs: number;
  weeklyWindowMs: number;
}): QuotaWindowsState {
  return {
    primary: createWindowState({ scope: "primary", windowMs: config.primaryWindowMs, subjects: config.subjects }),
    weekly: createWindowState({ scope: "weekly", windowMs: config.weeklyWindowMs, subjects: config.subjects }),
  };
}

export function reduceQuotaWindows(
  state: QuotaWindowsState,
  input: { scope: QuotaScope | "both"; event: WindowEvent },
): QuotaWindowsState {
  return {
    primary: input.scope === "primary" || input.scope === "both" ? reduceWindow(state.primary, input.event) : state.primary,
    weekly: input.scope === "weekly" || input.scope === "both" ? reduceWindow(state.weekly, input.event) : state.weekly,
  };
}
