/**
 * quota-profile-tracker.ts — Learns real upstream quota limits per plan type
 * from historical 429 exhaustion events.
 *
 * Each time an account hits a 429, we know that the total weighted usage
 * at that point approximates the real 5h (or weekly) budget. Over time,
 * collecting samples from many 429s lets us converge on accurate per-plan
 * quota estimates — replacing the hardcoded DEFAULT_BUDGETS table.
 *
 * Profiles are persisted to `quota-profiles.json` so they survive restarts.
 */

import * as fs from "fs";
import * as path from "path";

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

/** Debounce interval for disk writes (ms). */
const SAVE_DEBOUNCE_MS = 30_000;

/** Minimum totalUsed to consider a sample valid (avoid noise from empty windows). */
const MIN_SAMPLE_THRESHOLD = 10_000;

// ── Core class ──────────────────────────────────────────────────────────────

export class QuotaProfileTracker {
  private profiles = new Map<string, QuotaProfile>();
  private readonly filePath: string;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
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

    profile.lastUpdatedAt = Date.now();
    this.scheduleSave();
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

  /** Force-write to disk. Called on shutdown. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    this.save();
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

  private scheduleSave(): void {
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.save();
      }, SAVE_DEBOUNCE_MS);
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (raw && typeof raw === "object") {
        for (const [key, value] of Object.entries(raw)) {
          const v = value as any;
          this.profiles.set(key, {
            window5h: Number(v.window5h) || 0,
            weekly: Number(v.weekly) || 0,
            samples5h: Number(v.samples5h) || 0,
            samplesWeekly: Number(v.samplesWeekly) || 0,
            history5h: Array.isArray(v.history5h) ? v.history5h.map(Number).filter(Number.isFinite) : [],
            historyWeekly: Array.isArray(v.historyWeekly) ? v.historyWeekly.map(Number).filter(Number.isFinite) : [],
            lastUpdatedAt: Number(v.lastUpdatedAt) || 0,
          });
        }
      }
    } catch {
      // File missing or corrupt — start fresh.
    }
  }

  private save(): void {
    this.dirty = false;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = this.getAllProfiles();
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch {
      // Best-effort persistence.
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function profileKey(product: string, planType: string, family: string): string {
  return `${product}:${(planType || "free").toLowerCase()}:${family}`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}
