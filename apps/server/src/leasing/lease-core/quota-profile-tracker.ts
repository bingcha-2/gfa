/**
 * quota-profile-tracker.ts — Learns real upstream quota limits per plan type
 * from continuous quota-fraction samples (and 429 backstop samples).
 *
 * Each sample reverse-derives the account budget from the upstream remaining
 * fraction: estimated = totalUsedWeighted / (1 - fraction). Samples carry a
 * wall-clock timestamp; the learned budget is a TIME-DECAYED WEIGHTED MEDIAN
 * recomputed at read time (weight = exp(-(now - t) / τ)). This lets official
 * quota adjustments (e.g. 5h 100M→80M) converge within ~1–2τ instead of being
 * pinned by a stale majority of old samples.
 *
 * Profiles are persisted to the `QuotaProfile` table (one row per
 * provider+planType+family). Memory aggregate + periodic batch upsert: a sample
 * only mutates memory + marks the key dirty; a timer flushes. load() restores
 * the table into memory at startup (and upgrades legacy number[] history).
 */

// ── Types ───────────────────────────────────────────────────────────────────

/** One reverse-derived budget sample with its wall-clock timestamp (ms). */
export interface QuotaSample {
  v: number; // reverse-derived budget (weighted tokens)
  t: number; // epoch ms when sampled
}

export interface QuotaProfile {
  /** Read-time-recomputed 5h budget snapshot (status/降级 only; authority is history5h). */
  window5h: number;
  /** Read-time-recomputed weekly budget snapshot (status/降级 only). */
  weekly: number;
  /** Number of 5h samples ever recorded. */
  samples5h: number;
  /** Number of weekly samples ever recorded. */
  samplesWeekly: number;
  /** Recent 5h samples (most recent last). */
  history5h: QuotaSample[];
  /** Recent weekly samples (most recent last). */
  historyWeekly: QuotaSample[];
  /** Epoch ms of the last update. */
  lastUpdatedAt: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Maximum number of recent samples to retain per scope (count cap only — we
 *  NEVER physically delete by age; old samples decay to ~0 weight at read time,
 *  so deleting them would risk collapsing a profile to 0 after a long idle). */
const MAX_HISTORY = Math.max(10, Number(process.env.BCAI_QUOTA_MAX_HISTORY) || 50);

/** Periodic batch-write interval (ms). */
const FLUSH_INTERVAL_MS = 30_000;

/** Minimum totalUsed to consider a sample valid (avoid noise from empty windows). */
const MIN_SAMPLE_THRESHOLD = 10_000;

/** Time-decay constant τ for 5h budget (env, default 1.5 days). Smaller = tracks faster. */
export const DECAY_TAU_5H_MS = Math.max(3_600_000, Number(process.env.BCAI_QUOTA_DECAY_TAU_MS) || 1.5 * 24 * 60 * 60 * 1000);
/** Time-decay constant τ for weekly budget (env, default 8 days — weekly samples are sparse). */
export const DECAY_TAU_WEEKLY_MS = Math.max(3_600_000, Number(process.env.BCAI_QUOTA_DECAY_TAU_WEEKLY_MS) || 8 * 24 * 60 * 60 * 1000);
/** Admission gate: consumed = 1 - fraction must be ≥ this to sample (avoid the
 *  10–20× amplification of used/consumed when fraction→1). env, default 0.2. */
export const MIN_CONSUMED_TO_SAMPLE = Math.min(0.9, Math.max(0.01, Number(process.env.BCAI_QUOTA_MIN_CONSUMED) || 0.2));
/** Continuous-sampling trigger: sample once per ~10% drop in remaining fraction. */
export const SAMPLE_DROP_STEP = Math.min(0.5, Math.max(0.02, Number(process.env.BCAI_QUOTA_SAMPLE_DROP) || 0.10));
/** Trust learned weekly R/budget only once we have at least this many weekly samples. */
export const MIN_WEEKLY_SAMPLES = Math.max(1, Number(process.env.BCAI_MIN_WEEKLY_SAMPLES) || 8);
/** ...and at least this effective sample count (Σw)²/Σw² (guards against one fresh sample dominating). */
const MIN_WEEKLY_EFFECTIVE = 5;

// ── 周/5h 换算比 R(全局)──────────────────────────────────────────────────────
// 「一个周限额相当于多少个 5h 限额」。优先级(在调用方解析):卡级设置框 > 后台学习
// (weekly/5h) > 全局默认。全局默认 = env BCAI_WEEKLY_RATIO_DEFAULT,缺省 5。
/** 全局默认 R(env 可配,缺省 5)。 */
export const DEFAULT_WEEKLY_RATIO = Math.max(1, Number(process.env.BCAI_WEEKLY_RATIO_DEFAULT || 5));
/** R 的合理夹取区间:周窗口至少 4.235 个 5h、至多 30 个 5h(一周 ≈ 33.6 个 5h)。 */
export const MIN_WEEKLY_RATIO = 4.235;
export const MAX_WEEKLY_RATIO = 30;
/** 夹取 R;非法/非正 → 全局默认。 */
export function clampWeeklyRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return DEFAULT_WEEKLY_RATIO;
  return Math.min(MAX_WEEKLY_RATIO, Math.max(MIN_WEEKLY_RATIO, ratio));
}

// ── Core class ──────────────────────────────────────────────────────────────

export class QuotaProfileTracker {
  private profiles = new Map<string, QuotaProfile>();
  private dirty = new Set<string>();
  /** Per-now (秒级) memo for decayedWeightedMedian — read-time recompute is a hot path. */
  private medianCache = new Map<string, { sec: number; val: number }>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly prisma: any;
  private readonly nowFn: () => number;

  /**
   * @param prisma  PrismaService (or compatible). Omit in unit tests that only
   *                exercise the in-memory learning logic — persistence no-ops.
   */
  constructor(prisma?: any, opts?: { now?: () => number }) {
    this.prisma = prisma ?? null;
    this.nowFn = opts?.now || Date.now;
    if (this.prisma) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, FLUSH_INTERVAL_MS);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Record a quota sample (continuous per-10%-drop, or 429 backstop).
   *
   * Admission gates (all must pass):
   *  1. fraction must be a real reading (null/non-finite → drop; never treat
   *     "no data" as 0%).
   *  3. consumed = 1 - fraction ≥ MIN_CONSUMED_TO_SAMPLE (avoid fraction→1
   *     amplification; this also naturally filters rate-limit 429s where the
   *     account still has plenty of quota).
   *  4. totalUsedWeighted ≥ MIN_SAMPLE_THRESHOLD.
   * (Gate 2 — cross-window reset — and the 10% trigger live in the caller, which
   *  holds the per-account fraction stream; see LeaseService.)
   *
   * @param totalUsedWeighted  Sum of weighted tokens GFA consumed in the current window
   * @param fraction           Upstream remaining fraction (0~1), or null if unavailable
   * @param isWeekly           true for the weekly window, false for 5h
   */
  recordSample(
    product: string,
    planType: string,
    family: string,
    totalUsedWeighted: number,
    fraction: number | null,
    isWeekly: boolean,
  ): void {
    if (fraction == null || !Number.isFinite(fraction)) return;            // gate 1
    if (totalUsedWeighted < MIN_SAMPLE_THRESHOLD) return;                  // gate 4
    const f = Math.max(0, Math.min(1, fraction));
    const consumed = 1 - f;
    if (consumed < MIN_CONSUMED_TO_SAMPLE - 1e-9) return;                  // gate 3 (epsilon: 1-0.8 float)
    const estimated = totalUsedWeighted / consumed;

    const key = profileKey(product, planType, family);
    const profile = this.getOrCreate(key);
    const now = this.nowFn();
    const tau = isWeekly ? DECAY_TAU_WEEKLY_MS : DECAY_TAU_5H_MS;
    const hist = isWeekly ? profile.historyWeekly : profile.history5h;
    hist.push({ v: estimated, t: now });
    while (hist.length > MAX_HISTORY) hist.shift(); // count cap only, never age-delete
    if (isWeekly) {
      profile.weekly = decayedWeightedMedian(hist, now, tau);
      profile.samplesWeekly++;
    } else {
      profile.window5h = decayedWeightedMedian(hist, now, tau);
      profile.samples5h++;
    }
    profile.lastUpdatedAt = now;
    this.medianCache.delete(`${key}:5h`);
    this.medianCache.delete(`${key}:weekly`);
    this.dirty.add(key);
  }

  /** Retrieve a learned profile. Returns null if no data exists. */
  getProfile(product: string, planType: string, family: string): QuotaProfile | null {
    return this.profiles.get(profileKey(product, planType, family)) || null;
  }

  /** Get all profiles as a plain object (for status API), with read-time-recomputed budgets. */
  getAllProfiles(): Record<string, QuotaProfile> {
    const out: Record<string, QuotaProfile> = {};
    for (const [key, profile] of this.profiles) {
      const { provider, planType, family } = splitKey(key);
      out[key] = {
        ...profile,
        window5h: this.getLearnedBudget5h(provider, planType, family),
        weekly: this.getLearnedBudgetWeekly(provider, planType, family),
      };
    }
    return out;
  }

  /** Get the learned 5h budget for a given plan+family, or 0 if unknown (read-time recompute). */
  getLearnedBudget5h(product: string, planType: string, family: string): number {
    const key = profileKey(product, planType, family);
    const p = this.profiles.get(key);
    if (!p || p.history5h.length === 0) return 0;
    return this.cachedMedian(`${key}:5h`, p.history5h, DECAY_TAU_5H_MS);
  }

  /**
   * Get the learned **weekly** budget, or 0 if unknown OR not yet trustworthy.
   * Returns 0 until weekly samples pass the trust gate (MIN_WEEKLY_SAMPLES +
   * effective count), so fair-share falls back to the 5h×R floor during the
   * sparse-weekly transition, and only switches to the learned weekly median —
   * which can converge DOWNWARD on an official cut — once well-learned.
   */
  getLearnedBudgetWeekly(product: string, planType: string, family: string): number {
    const key = profileKey(product, planType, family);
    const p = this.profiles.get(key);
    if (!p || p.historyWeekly.length === 0) return 0;
    if (!this.weeklyTrustworthy(p)) return 0;
    return this.cachedMedian(`${key}:weekly`, p.historyWeekly, DECAY_TAU_WEEKLY_MS);
  }

  /**
   * 周/5h 换算比 R 的「学习/默认」部分(卡级设置框的覆盖在调用方处理)。
   * 周样本足够可信(MIN_WEEKLY_SAMPLES + 有效样本数)且 5h/周都学到 → weekly/5h(夹取);
   * 否则全局默认 5(过渡期周不信学习 R)。
   */
  getWeeklyToShortRatio(product: string, planType: string, family: string): number {
    const b5 = this.getLearnedBudget5h(product, planType, family);
    const bw = this.getLearnedBudgetWeekly(product, planType, family); // already trust-gated
    if (b5 > 0 && bw > 0) return clampWeeklyRatio(bw / b5);
    return DEFAULT_WEEKLY_RATIO;
  }

  /** Restore persisted profiles into memory. Call once at startup. */
  async load(): Promise<void> {
    if (!this.prisma) return;
    try {
      const rows = await this.prisma.quotaProfile.findMany();
      const now = this.nowFn();
      for (const r of rows) {
        const key = profileKey(String(r.provider), String(r.planType), String(r.family));
        // Legacy bare number[] history has no timestamp — give it a conservative
        // (old, low-weight) t so it doesn't dominate post-migration fresh samples.
        this.profiles.set(key, {
          window5h: Number(r.window5h) || 0,
          weekly: Number(r.weekly) || 0,
          samples5h: Number(r.samples5h) || 0,
          samplesWeekly: Number(r.samplesWeekly) || 0,
          history5h: parseSampleArray(r.history5h, now - 3 * DECAY_TAU_5H_MS),
          historyWeekly: parseSampleArray(r.historyWeekly, now - 3 * DECAY_TAU_WEEKLY_MS),
          lastUpdatedAt: Number(r.lastUpdatedAt) || 0,
        });
      }
    } catch (err) {
      console.error("[quota-profile-tracker] load failed:", err);
    }
  }

  /** Upsert all dirty profiles. Runs on a timer and on shutdown. */
  async flush(): Promise<void> {
    if (!this.prisma || this.dirty.size === 0) return;
    const keys = [...this.dirty];
    this.dirty.clear();
    for (const key of keys) {
      const profile = this.profiles.get(key);
      if (!profile) continue;
      const { provider, planType, family } = splitKey(key);
      const data = {
        // Persist a current read-time snapshot for status display + downgrade safety net.
        window5h: this.getLearnedBudget5h(provider, planType, family),
        weekly: this.getLearnedBudgetWeekly(provider, planType, family),
        samples5h: profile.samples5h,
        samplesWeekly: profile.samplesWeekly,
        history5h: JSON.stringify(profile.history5h),
        historyWeekly: JSON.stringify(profile.historyWeekly),
        lastUpdatedAt: BigInt(Math.trunc(profile.lastUpdatedAt)),
      };
      try {
        await this.prisma.quotaProfile.upsert({
          where: { provider_planType_family: { provider, planType, family } },
          create: { provider, planType, family, ...data },
          update: data,
        });
      } catch (err) {
        console.error("[quota-profile-tracker] flush failed:", err);
        this.dirty.add(key); // retry on the next tick
      }
    }
  }

  /** Stop the periodic flush timer. */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────

  /** Weekly samples trustworthy enough to use the learned weekly median / R. */
  private weeklyTrustworthy(p: QuotaProfile): boolean {
    if (p.samplesWeekly < MIN_WEEKLY_SAMPLES) return false;
    return effectiveSampleCount(p.historyWeekly, this.nowFn(), DECAY_TAU_WEEKLY_MS) >= MIN_WEEKLY_EFFECTIVE;
  }

  /** decayedWeightedMedian with a per-now (秒级) memo (read-time recompute is hot). */
  private cachedMedian(cacheKey: string, hist: QuotaSample[], tau: number): number {
    const now = this.nowFn();
    const sec = Math.floor(now / 1000);
    const hit = this.medianCache.get(cacheKey);
    if (hit && hit.sec === sec) return hit.val;
    const val = decayedWeightedMedian(hist, now, tau);
    this.medianCache.set(cacheKey, { sec, val });
    return val;
  }

  private getOrCreate(key: string): QuotaProfile {
    let profile = this.profiles.get(key);
    if (!profile) {
      profile = {
        window5h: 0,
        weekly: 0,
        samples5h: 0,
        samplesWeekly: 0,
        history5h: [],
        historyWeekly: [],
        lastUpdatedAt: 0,
      };
      this.profiles.set(key, profile);
    }
    return profile;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function profileKey(product: string, planType: string, family: string): string {
  return `${product}:${(planType || "free").toLowerCase()}:${family}`;
}

/** Inverse of profileKey. product/planType/family never contain ':'. */
function splitKey(key: string): { provider: string; planType: string; family: string } {
  const [provider = "", planType = "", family = ""] = key.split(":");
  return { provider, planType, family };
}

/** Parse history JSON, accepting both new {v,t}[] and legacy number[] (upgraded with fallbackT). */
function parseSampleArray(raw: unknown, fallbackT: number): QuotaSample[] {
  let arr: unknown;
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "string") {
    try { arr = JSON.parse(raw); } catch { return []; }
  } else return [];
  if (!Array.isArray(arr)) return [];
  const out: QuotaSample[] = [];
  for (const item of arr) {
    if (typeof item === "number") {
      if (Number.isFinite(item)) out.push({ v: item, t: fallbackT });
    } else if (item && typeof item === "object") {
      const v = Number((item as any).v);
      const t = Number((item as any).t);
      if (Number.isFinite(v)) out.push({ v, t: Number.isFinite(t) ? t : fallbackT });
    }
  }
  return out;
}

/** Effective sample count under time-decay weights: (Σw)² / Σw². */
function effectiveSampleCount(samples: QuotaSample[], now: number, tau: number): number {
  if (!samples.length) return 0;
  let s = 0;
  let s2 = 0;
  for (const x of samples) {
    const w = Math.exp(-Math.max(0, now - x.t) / tau);
    s += w;
    s2 += w * w;
  }
  return s2 > 0 ? (s * s) / s2 : 0;
}

/**
 * Time-decayed weighted median: weight_i = exp(-(now - t_i)/τ).
 * Degenerates exactly to the classic median when all timestamps are equal
 * (equal weights): odd n → middle element; even n → average of the two middle
 * elements (rounded). Collapse protection: if all weights underflow to ~0
 * (samples far older than τ), return the most-recent sample value instead of 0.
 */
export function decayedWeightedMedian(samples: QuotaSample[], now: number, tau: number): number {
  if (!samples.length) return 0;
  const arr = samples
    .map((s) => ({ v: s.v, w: Math.exp(-Math.max(0, now - s.t) / tau) }))
    .sort((a, b) => a.v - b.v);
  let total = 0;
  for (const x of arr) total += x.w;
  if (!(total > 0) || !Number.isFinite(total)) {
    // All weights underflowed — fall back to the most-recent sample value.
    let latest = samples[0];
    for (const s of samples) if (s.t > latest.t) latest = s;
    return Math.round(latest.v);
  }
  const half = total / 2;
  let cum = 0;
  for (let i = 0; i < arr.length; i++) {
    cum += arr[i].w;
    if (cum > half) return Math.round(arr[i].v);
    if (cum === half) {
      const next = arr[i + 1];
      return next ? Math.round((arr[i].v + next.v) / 2) : Math.round(arr[i].v);
    }
  }
  return Math.round(arr[arr.length - 1].v);
}
