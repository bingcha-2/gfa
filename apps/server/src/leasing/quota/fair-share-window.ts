export const REORDER_HORIZON_MS = 10 * 60 * 1000;
export const REORDER_MAX_EVENTS = 10_000;
export const REORDER_MAX_BYTES = 1024 * 1024;

export type QuotaScope = "primary" | "weekly";

export interface WindowSubjectConfig {
  quotaSubjectId: string;
  share: number;
  exclusive?: boolean;
}

export interface WindowSubjectState extends WindowSubjectConfig {
  active: boolean;
  cumulativeCu: number;
  /** Attribution imported at the segment-v1 cutover. It has no compatible CU
   * denominator, so it is carried separately until rebound or reset. */
  carriedAttributedShare: number;
  /** Attribution produced from post-cutover CU only. */
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
  lastPresenceAt: number;
  assignedBurn: number;
  unattributedShare: number;
  subjects: Record<string, WindowSubjectState>;
  compactedThroughAt: number;
}

export interface FairShareWindowState extends WindowCoreState {
  revision: number;
  base: WindowCoreState;
  reorderTail: WindowEvent[];
  reorderTailBytes: number;
  lastReason?: string;
  lastCompactionCount?: number;
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

function materializedCore(state: FairShareWindowState): WindowCoreState {
  const {
    revision: _revision,
    base: _base,
    reorderTail: _reorderTail,
    reorderTailBytes: _reorderTailBytes,
    lastReason: _lastReason,
    lastCompactionCount: _lastCompactionCount,
    ...core
  } = state;
  return cloneCore(core);
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

function totalCarried(core: WindowCoreState): number {
  return Object.values(core.subjects)
    .reduce((sum, subject) => sum + positive(subject.carriedAttributedShare), 0);
}

function recomputeAttribution(core: WindowCoreState): void {
  const sum = totalCu(core);
  for (const subject of Object.values(core.subjects)) {
    subject.attributedShare = sum > 0 ? core.assignedBurn * positive(subject.cumulativeCu) / sum : 0;
  }
}

function resetCore(core: WindowCoreState, event: SnapshotEvent): WindowCoreState {
  const subjects = Object.fromEntries(Object.entries(cloneSubjects(core.subjects)).filter(([, subject]) => subject.active));
  const fraction = clamp01(event.fraction);
  for (const subject of Object.values(subjects)) {
    subject.cumulativeCu = 0;
    subject.carriedAttributedShare = 0;
    subject.attributedShare = 0;
  }
  const activeSubjects = Object.values(subjects);
  // If durable accounting is unavailable but exactly one full-seat exclusive
  // owner exists, the mother's already-consumed share can only belong to it.
  // Shared/multi-member accounts remain unattributed because ownership is not
  // provable from a snapshot alone.
  if (activeSubjects.length === 1 && activeSubjects[0].exclusive && activeSubjects[0].share >= 1) {
    activeSubjects[0].carriedAttributedShare = 1 - fraction;
  }
  return {
    ...core,
    primed: true,
    windowStart: event.resetAt - core.windowMs,
    resetAt: event.resetAt,
    fraction,
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
        : {
            ...config,
            share: clamp01(config.share),
            active: true,
            cumulativeCu: 0,
            carriedAttributedShare: 0,
            attributedShare: 0,
          };
    }
    core.compactedThroughAt = Math.max(core.compactedThroughAt, causalAt(event));
    return core;
  }

  if (!Number.isFinite(event.fraction) || event.fraction < 0 || event.fraction > 1) return core;
  const fraction = clamp01(event.fraction);
  const hasValidResetAt = Number.isFinite(event.resetAt) && event.resetAt > 0;
  if (!core.primed) {
    if (!hasValidResetAt) return core;
    core = resetCore(core, { ...event, fraction });
    core.compactedThroughAt = Math.max(core.compactedThroughAt, causalAt(event));
    return core;
  }

  const forwardReset = hasValidResetAt
    && event.resetAt > core.resetAt + 60_000
    && event.observedAt >= core.resetAt;
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
    const carried = totalCarried(core);
    const burned = carried + core.assignedBurn + core.unattributedShare;
    if (burned > 0) {
      const refund = Math.min(recovery, burned);
      const factor = (burned - refund) / burned;
      for (const subject of Object.values(core.subjects)) {
        subject.carriedAttributedShare *= factor;
        if (subject.carriedAttributedShare < 1e-15) subject.carriedAttributedShare = 0;
      }
      core.assignedBurn -= refund * core.assignedBurn / burned;
      core.unattributedShare -= refund * core.unattributedShare / burned;
      if (core.assignedBurn < 1e-15) core.assignedBurn = 0;
      if (core.unattributedShare < 1e-15) core.unattributedShare = 0;
      recomputeAttribution(core);
    }
  }
  core.fraction = fraction;
  // resetAt is an upstream window boundary, not ordinary snapshot data. A
  // missing or backward-drifting value must not shorten the current window.
  if (hasValidResetAt && event.resetAt >= core.resetAt) core.resetAt = event.resetAt;
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

function eventBytes(event: WindowEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function appendTailBytes(currentBytes: number, currentLength: number, event: WindowEvent): number {
  return currentBytes + eventBytes(event) + (currentLength > 0 ? 1 : 0);
}

function removeFirstTailBytes(currentBytes: number, currentLength: number, event: WindowEvent): number {
  return currentBytes - eventBytes(event) - (currentLength > 1 ? 1 : 0);
}

function compact(base: WindowCoreState, tail: WindowEvent[], currentBytes: number, cutoff: number): {
  base: WindowCoreState;
  tail: WindowEvent[];
  tailBytes: number;
  capacityCompacted: number;
} {
  // reorderTail is always sorted. In the common case its first event is still
  // inside the horizon, so avoid copying/scanning the whole retained window.
  let foldCount = 0;
  while (foldCount < tail.length && causalAt(tail[foldCount]) < cutoff) foldCount++;
  const fold = foldCount > 0 ? tail.slice(0, foldCount) : [];
  let keep = foldCount > 0 ? tail.slice(foldCount) : tail;
  let keepBytes = currentBytes;
  for (let index = 0; index < foldCount; index++) {
    keepBytes = removeFirstTailBytes(keepBytes, tail.length - index, tail[index]);
  }
  let nextBase = fold.reduce(applyCoreEvent, cloneCore(base));
  let capacityCompacted = 0;
  if (keep === tail && (keep.length >= REORDER_MAX_EVENTS || keepBytes >= REORDER_MAX_BYTES)) {
    keep = [...keep];
  }
  while (keep.length >= REORDER_MAX_EVENTS || keepBytes >= REORDER_MAX_BYTES) {
    const oldest = keep.shift();
    if (!oldest) break;
    keepBytes = removeFirstTailBytes(keepBytes, keep.length + 1, oldest);
    nextBase = applyCoreEvent(nextBase, oldest);
    capacityCompacted++;
  }
  return { base: nextBase, tail: keep, tailBytes: keepBytes, capacityCompacted };
}

/**
 * Persist only the current materialized accounting. The large causal tail is a
 * process-local reorder aid; carrying it in every SQLite checkpoint would turn
 * a bounded memory feature into multi-megabyte write amplification.
 */
export function compactWindowForCheckpoint(state: FairShareWindowState): FairShareWindowState {
  const core = materializedCore(state);
  return {
    ...cloneCore(core),
    revision: state.revision,
    base: cloneCore(core),
    reorderTail: [],
    reorderTailBytes: 2,
    ...(state.lastReason ? { lastReason: state.lastReason } : {}),
    ...(state.lastCompactionCount != null ? { lastCompactionCount: state.lastCompactionCount } : {}),
  };
}

export function collapseWindowReorderTail(
  state: FairShareWindowState,
  reason = "WINDOW_GLOBAL_TAIL_COMPACTED",
): FairShareWindowState {
  if (state.reorderTail.length === 0) return state;
  const core = materializedCore(state);
  return {
    ...cloneCore(core),
    revision: state.revision + 1,
    base: cloneCore(core),
    reorderTail: [],
    reorderTailBytes: 2,
    lastReason: reason,
    lastCompactionCount: state.reorderTail.length,
  };
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
    carriedAttributedShare: 0,
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
    lastPresenceAt: 0,
    assignedBurn: 0,
    unattributedShare: 0,
    subjects,
    compactedThroughAt: 0,
  };
  return { ...cloneCore(base), revision: 0, base, reorderTail: [], reorderTailBytes: 2 };
}

/**
 * Builds a window-cu state from the fixed-size segment-v1 summary. Legacy T_i
 * is intentionally not converted into CU: no lossless denominator exists.
 * The unexplained part of the mother burn remains unattributed, while all
 * post-cutover usage starts with a clean CU ledger.
 */
export function createCarriedWindowState(config: {
  scope: QuotaScope;
  windowMs: number;
  windowStart: number;
  fraction: number;
  lastSnapshotAt?: number;
  subjects: Array<WindowSubjectConfig & {
    active: boolean;
    carriedAttributedShare: number;
  }>;
}): FairShareWindowState {
  const state = createWindowState({
    scope: config.scope,
    windowMs: config.windowMs,
    subjects: config.subjects,
  });
  const fraction = Number.isFinite(config.fraction) ? clamp01(config.fraction) : 1;
  for (const subject of config.subjects) {
    const target = state.subjects[subject.quotaSubjectId];
    target.active = subject.active;
    target.carriedAttributedShare = positive(subject.carriedAttributedShare);
  }
  const confirmedBurn = 1 - fraction;
  const carried = totalCarried(state);
  // Legacy rows can exceed the mother burn by tiny floating-point drift (or
  // old corrupt data). Preserve their ratios while restoring conservation.
  if (carried > confirmedBurn && carried > 0) {
    const factor = confirmedBurn / carried;
    for (const subject of Object.values(state.subjects)) {
      subject.carriedAttributedShare *= factor;
    }
  }
  state.primed = true;
  state.windowStart = config.windowStart;
  state.resetAt = config.windowStart + config.windowMs;
  state.fraction = fraction;
  state.lastSnapshotAt = config.lastSnapshotAt ?? config.windowStart;
  state.unattributedShare = Math.max(0, confirmedBurn - totalCarried(state));
  state.compactedThroughAt = state.lastSnapshotAt;
  const {
    revision: _revision,
    base: _base,
    reorderTail: _tail,
    reorderTailBytes: _tailBytes,
    lastReason: _reason,
    ...core
  } = state;
  state.base = cloneCore(core);
  return state;
}

export function reduceWindow(state: FairShareWindowState, incoming: WindowEvent): FairShareWindowState {
  if (state.reorderTail.some((event) => sameEventId(event, incoming))) {
    return { ...state, lastReason: "EVENT_DUPLICATE" };
  }
  if (incoming.kind === "snapshot"
    && (!Number.isFinite(incoming.fraction) || incoming.fraction < 0 || incoming.fraction > 1)) {
    return { ...state, lastReason: "SNAPSHOT_INVALID_FRACTION" };
  }
  if (incoming.kind === "snapshot" && !state.primed
    && (!Number.isFinite(incoming.resetAt) || incoming.resetAt <= 0)) {
    return { ...state, lastReason: "SNAPSHOT_INVALID_RESET_AT" };
  }

  const cutoff = incoming.arrivedAt - REORDER_HORIZON_MS;
  const compacted = compact(
    state.base,
    state.reorderTail,
    Number.isFinite(state.reorderTailBytes) ? state.reorderTailBytes : tailBytes(state.reorderTail),
    cutoff,
  );
  // Events newer than the compacted base can still be inserted into the
  // causal tail and replayed. Once their causal position has crossed the
  // bounded horizon, accepting them would require undoing compacted history.
  if (incoming.kind === "snapshot" && incoming.observedAt <= compacted.base.compactedThroughAt) {
    return { ...state, lastReason: "SNAPSHOT_STALE_OBSERVED_AT" };
  }
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

  const appendsAfterTail = compacted.tail.length === 0
    || compareEvents(compacted.tail[compacted.tail.length - 1], event) <= 0;
  let tail = appendsAfterTail
    ? [...compacted.tail, event]
    : [...compacted.tail, event].sort(compareEvents);
  let encodedTailBytes = appendTailBytes(compacted.tailBytes, compacted.tail.length, event);
  let base = compacted.base;
  let capacityCompacted = compacted.capacityCompacted;
  while (tail.length > REORDER_MAX_EVENTS || encodedTailBytes > REORDER_MAX_BYTES) {
    const oldest = tail.shift();
    if (!oldest) break;
    encodedTailBytes = removeFirstTailBytes(encodedTailBytes, tail.length + 1, oldest);
    base = applyCoreEvent(base, oldest);
    capacityCompacted++;
  }
  const materialized = appendsAfterTail
    ? applyCoreEvent(materializedCore(state), event)
    : replay(base, tail);
  if (!lastReason && capacityCompacted > 0) lastReason = "WINDOW_TAIL_COMPACTED";
  return {
    ...materialized,
    revision: state.revision + 1,
    base,
    reorderTail: tail,
    reorderTailBytes: encodedTailBytes,
    lastReason,
    ...(capacityCompacted > 0 ? { lastCompactionCount: capacityCompacted } : {}),
  };
}

export function getSubjectQuota(state: FairShareWindowState, quotaSubjectId: string): {
  fraction: number;
  personalFraction: number;
  share: number;
  absoluteRemaining: number;
} {
  const subject = state.subjects[quotaSubjectId];
  if (!subject || !subject.active || subject.share <= 0) {
    return { fraction: 0, personalFraction: 0, share: subject?.share || 0, absoluteRemaining: 0 };
  }
  const attributed = positive(subject.carriedAttributedShare) + positive(subject.attributedShare);
  const raw = Math.max(0, subject.share - attributed);
  const activeSubjects = Object.values(state.subjects).filter((value) => value.active);
  const rawTotal = activeSubjects
    .reduce((sum, value) => sum + Math.max(
      0,
      value.share - positive(value.carriedAttributedShare) - positive(value.attributedShare),
    ), 0);
  // Exclusive changes allocation ownership, never conservation: even one sole
  // exclusive card cannot expose more absolute quota than the mother has left.
  const scale = rawTotal > state.fraction ? state.fraction / rawTotal : 1;
  const absoluteRemaining = raw * scale;
  return {
    fraction: clamp01(absoluteRemaining / subject.share),
    personalFraction: clamp01(raw / subject.share),
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
