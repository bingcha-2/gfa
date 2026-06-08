/**
 * quota-profile-tracker.ts — Learns real upstream quota limits per plan type
 * from historical 429 exhaustion events.
 *
 * Each time an account hits a 429, we know that the total weighted usage
 * at that point approximates the real 5h (or weekly) budget. Over time,
 * collecting samples from many 429s lets us converge on accurate per-plan
 * quota estimates — replacing the hardcoded DEFAULT_BUDGETS table.
 *
 * Profiles are persisted to the `QuotaProfile` table (one row per
 * provider+planType+family). Following the "memory aggregate + periodic batch
 * write" pattern (no-WAL): recordExhaustion only mutates memory + marks the key
 * dirty; a timer flushes dirty profiles via upsert. load() restores the table
 * into memory at startup.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface QuotaProfile {
  /** Learned 5h window budget in weighted token units. 0 = unknown. */
  window5h: number;
  /** Learned weekly budget in weighted token units. 0 = unknown. */
  weekly: number;
  /** Number of 429 samples that contributed to the 5h estimate. */
  samples5h: number;
  /** Number of 429 samples that contributed to the weekly estimate. */
  samplesWeekly: number;
  /** Recent 5h sample values (most recent last). */
  history5h: number[];
  /** Recent weekly sample values (most recent last). */
  historyWeekly: number[];
  /** Epoch ms of the last update. */
  lastUpdatedAt: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Maximum number of recent samples to retain per profile. */
const MAX_HISTORY = 20;

/** Periodic batch-write interval (ms). 429s are rare, so 30s is plenty. */
const FLUSH_INTERVAL_MS = 30_000;

/** Minimum totalUsed to consider a sample valid (avoid noise from empty windows). */
const MIN_SAMPLE_THRESHOLD = 10_000;

// ── Core class ──────────────────────────────────────────────────────────────

export class QuotaProfileTracker {
  private profiles = new Map<string, QuotaProfile>();
  private dirty = new Set<string>();
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
   * Record a 429 exhaustion event. Called from LeaseService.reportResult
   * when an upstream 429 is received for a bound account.
   *
   * @param product    "antigravity" | "codex" | "anthropic"
   * @param planType   "ultra" | "pro" | "max" | "plus" | etc.
   * @param family     "gemini" | "claude" | "gpt"
   * @param totalUsedWeighted  Sum of weighted tokens consumed by GFA in the current window
   * @param lastFraction       Last upstream remaining fraction (0~1)
   * @param isWeekly           true if the resetTime indicates a weekly window (> 5h from now)
   */
  recordExhaustion(
    product: string,
    planType: string,
    family: string,
    totalUsedWeighted: number,
    lastFraction: number,
    isWeekly: boolean,
  ): void {
    if (totalUsedWeighted < MIN_SAMPLE_THRESHOLD) return;

    const key = profileKey(product, planType, family);
    const profile = this.getOrCreate(key);

    // Estimate real budget from fraction signal
    const consumed = 1 - Math.max(0, Math.min(1, lastFraction));
    const estimated = consumed > 0.1
      ? totalUsedWeighted / consumed
      : totalUsedWeighted; // fraction ≈ 1 → unreliable, use totalUsed as floor

    if (isWeekly) {
      profile.historyWeekly.push(estimated);
      if (profile.historyWeekly.length > MAX_HISTORY) profile.historyWeekly.shift();
      profile.weekly = median(profile.historyWeekly);
      profile.samplesWeekly++;
    } else {
      profile.history5h.push(estimated);
      if (profile.history5h.length > MAX_HISTORY) profile.history5h.shift();
      profile.window5h = median(profile.history5h);
      profile.samples5h++;
    }

    profile.lastUpdatedAt = this.nowFn();
    this.dirty.add(key);
  }

  /** Retrieve a learned profile. Returns null if no data exists. */
  getProfile(product: string, planType: string, family: string): QuotaProfile | null {
    return this.profiles.get(profileKey(product, planType, family)) || null;
  }

  /** Get all profiles as a plain object (for status API). */
  getAllProfiles(): Record<string, QuotaProfile> {
    const out: Record<string, QuotaProfile> = {};
    for (const [key, profile] of this.profiles) {
      out[key] = { ...profile };
    }
    return out;
  }

  /** Get the learned 5h budget for a given plan+family, or 0 if unknown. */
  getLearnedBudget5h(product: string, planType: string, family: string): number {
    const profile = this.getProfile(product, planType, family);
    return profile?.window5h || 0;
  }

  /** Restore persisted profiles into memory. Call once at startup. */
  async load(): Promise<void> {
    if (!this.prisma) return;
    try {
      const rows = await this.prisma.quotaProfile.findMany();
      for (const r of rows) {
        const key = profileKey(String(r.provider), String(r.planType), String(r.family));
        this.profiles.set(key, {
          window5h: Number(r.window5h) || 0,
          weekly: Number(r.weekly) || 0,
          samples5h: Number(r.samples5h) || 0,
          samplesWeekly: Number(r.samplesWeekly) || 0,
          history5h: parseNumArray(r.history5h),
          historyWeekly: parseNumArray(r.historyWeekly),
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
        window5h: profile.window5h,
        weekly: profile.weekly,
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

function parseNumArray(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite);
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}
