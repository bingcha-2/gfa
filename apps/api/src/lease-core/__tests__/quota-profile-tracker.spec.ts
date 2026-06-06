import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { QuotaProfileTracker } from "../quota-profile-tracker";

describe("QuotaProfileTracker", () => {
  let tempFilePath: string;

  beforeEach(() => {
    tempFilePath = path.join(os.tmpdir(), `quota-profiles-test-${Date.now()}-${Math.random().toString(36).substring(2)}.json`);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    } catch {
      // ignore
    }
  });

  it("should record 429 exhaustion events and calculate median correctly", () => {
    const tracker = new QuotaProfileTracker(tempFilePath);

    // Record some 5h samples
    // (product, planType, family, totalUsedWeighted, lastFraction, isWeekly)
    tracker.recordExhaustion("antigravity", "ultra", "claude", 200000, 0.2, false); // estimated = 200000 / 0.8 = 250000
    tracker.recordExhaustion("antigravity", "ultra", "claude", 300000, 0.1, false); // estimated = 300000 / 0.9 = 333333
    tracker.recordExhaustion("antigravity", "ultra", "claude", 180000, 0.4, false); // estimated = 180000 / 0.6 = 300000

    const profile = tracker.getProfile("antigravity", "ultra", "claude");
    expect(profile).toBeDefined();
    expect(profile?.samples5h).toBe(3);
    // Median of [250000, 333333, 300000] is 300000
    expect(profile?.window5h).toBe(300000);

    // Retrieve learned budget directly
    const learned = tracker.getLearnedBudget5h("antigravity", "ultra", "claude");
    expect(learned).toBe(300000);
  });

  it("should handle fraction close to 1 by falling back to totalUsed as floor", () => {
    const tracker = new QuotaProfileTracker(tempFilePath);
    
    // fraction = 0.95 -> consumed = 0.05 (<= 0.1), should use totalUsed directly
    tracker.recordExhaustion("antigravity", "ultra", "claude", 150000, 0.95, false);

    const profile = tracker.getProfile("antigravity", "ultra", "claude");
    expect(profile?.window5h).toBe(150000);
  });

  it("should filter out low totalUsed samples below MIN_SAMPLE_THRESHOLD (10_000)", () => {
    const tracker = new QuotaProfileTracker(tempFilePath);
    
    tracker.recordExhaustion("antigravity", "ultra", "claude", 5000, 0.5, false); // < 10000
    const profile = tracker.getProfile("antigravity", "ultra", "claude");
    expect(profile).toBeNull();
  });

  it("should handle weekly samples separately", () => {
    const tracker = new QuotaProfileTracker(tempFilePath);

    tracker.recordExhaustion("antigravity", "ultra", "claude", 200000, 0.2, true); // Weekly
    tracker.recordExhaustion("antigravity", "ultra", "claude", 300000, 0.2, false); // 5h

    const profile = tracker.getProfile("antigravity", "ultra", "claude");
    expect(profile?.samplesWeekly).toBe(1);
    expect(profile?.samples5h).toBe(1);
    expect(profile?.weekly).toBe(250000); // 200000 / 0.8
    expect(profile?.window5h).toBe(375000); // 300000 / 0.8
  });

  it("should persist and load profiles correctly", () => {
    const tracker1 = new QuotaProfileTracker(tempFilePath);
    tracker1.recordExhaustion("antigravity", "ultra", "claude", 240000, 0.2, false); // 240k / 0.8 = 300k
    
    // Force write to disk
    tracker1.flush();

    expect(fs.existsSync(tempFilePath)).toBe(true);

    // Load in a new tracker
    const tracker2 = new QuotaProfileTracker(tempFilePath);
    const learned = tracker2.getLearnedBudget5h("antigravity", "ultra", "claude");
    expect(learned).toBe(300000);
  });
});
