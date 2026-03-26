/**
 * AdsPower Smoke Test
 *
 * Requires a locally running AdsPower desktop application.
 * Reads config from environment variables (auto-loaded from .env by vitest).
 *
 * Run:
 *   pnpm --filter @gfa/worker test:smoke
 *
 * This test is SKIPPED automatically when:
 *   - ADSPOWER_POOL_IDS is empty / not set
 *   - AdsPower API is unreachable (connection refused)
 *
 * It will NOT run during normal `pnpm test` (vitest.config.ts excludes *.smoke.spec.ts).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { AdsPowerClient } from "../adspower-client";
import * as dotenv from "dotenv";
import { resolve } from "node:path";

// Load .env from repo root (two levels up from apps/worker)
dotenv.config({ path: resolve(__dirname, "../../../../.env") });

const ADSPOWER_HOST = process.env.ADSPOWER_HOST ?? "http://127.0.0.1:50325";
const ADSPOWER_API_KEY = process.env.ADSPOWER_API_KEY;
const RAW_POOL_IDS = process.env.ADSPOWER_POOL_IDS ?? "";
const PROFILE_IDS = RAW_POOL_IDS.split(",").map((s) => s.trim()).filter(Boolean);

// ----- Reachability check -----

async function isAdsPowerReachable(): Promise<boolean> {
  try {
    const url = new URL("/api/v1/browser/active", ADSPOWER_HOST);
    url.searchParams.set("serial_number", PROFILE_IDS[0] ?? "0");
    const headers: Record<string, string> = {};
    if (ADSPOWER_API_KEY) headers["Authorization"] = `Bearer ${ADSPOWER_API_KEY}`;
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(3000) });
    return res.ok || res.status === 200;
  } catch {
    return false;
  }
}

// ----- Test suite -----

describe("AdsPower Smoke Test", () => {
  let client: AdsPowerClient;
  let targetProfileId: string;
  let adsPowerReachable = false;

  beforeAll(async () => {
    client = new AdsPowerClient({
      baseUrl: ADSPOWER_HOST,
      apiKey: ADSPOWER_API_KEY,
      maxRetries: 2,
      retryDelayMs: 2000,
    });

    adsPowerReachable = await isAdsPowerReachable();

    if (!adsPowerReachable) {
      console.warn(`[smoke] AdsPower not reachable at ${ADSPOWER_HOST} — all tests will be skipped`);
    } else {
      console.log(`[smoke] AdsPower reachable at ${ADSPOWER_HOST}`);
    }

    targetProfileId = PROFILE_IDS[0];
  });

  // Helper: skip if prerequisites not met
  function requiresAdspower(fn: () => Promise<void>) {
    return async () => {
      if (!adsPowerReachable) {
        console.warn("[smoke] SKIP — AdsPower not reachable");
        return;
      }
      if (!targetProfileId) {
        console.warn("[smoke] SKIP — ADSPOWER_POOL_IDS not configured");
        return;
      }
      await fn();
    };
  }

  it(
    "PING: AdsPower API responds to checkProfile",
    requiresAdspower(async () => {
      const result = await client.checkProfile(targetProfileId);
      // Result shape is valid regardless of active/inactive
      expect(typeof result.active).toBe("boolean");
      console.log(`[smoke] Profile ${targetProfileId} active=${result.active}`);
    })
  );

  it(
    "OPEN: openProfile returns a valid CDP debugUrl",
    { timeout: 30_000 },
    requiresAdspower(async () => {
      console.log(`[smoke] Opening profile ${targetProfileId}...`);
      const result = await client.openProfile(targetProfileId);

      expect(result.debugUrl).toBeTruthy();
      expect(result.debugUrl).toMatch(/^ws:\/\//);
      console.log(`[smoke] CDP debugUrl: ${result.debugUrl}`);
    })
  );

  it(
    "VERIFY: checkProfile shows active=true after openProfile",
    { timeout: 10_000 },
    requiresAdspower(async () => {
      const result = await client.checkProfile(targetProfileId);
      expect(result.active).toBe(true);
      expect(result.debugUrl).toMatch(/^ws:\/\//);
      console.log(`[smoke] Confirmed active, debugUrl: ${result.debugUrl}`);
    })
  );

  it(
    "CLOSE: closeProfile shuts down the browser without throwing",
    { timeout: 15_000 },
    requiresAdspower(async () => {
      console.log(`[smoke] Closing profile ${targetProfileId}...`);
      await expect(client.closeProfile(targetProfileId)).resolves.toBeUndefined();
      console.log(`[smoke] Profile ${targetProfileId} closed`);
    })
  );

  it(
    "VERIFY: checkProfile shows active=false after closeProfile",
    { timeout: 10_000 },
    requiresAdspower(async () => {
      // Give AdsPower a moment to fully close the browser
      await new Promise((r) => setTimeout(r, 2000));
      const result = await client.checkProfile(targetProfileId);
      expect(result.active).toBe(false);
      console.log(`[smoke] Confirmed inactive after close`);
    })
  );

  it(
    "FULL CYCLE: open → verify active → close → verify inactive",
    { timeout: 60_000 },
    requiresAdspower(async () => {
      // Open
      const openResult = await client.openProfile(targetProfileId);
      expect(openResult.debugUrl).toMatch(/^ws:\/\//);
      console.log(`[smoke] Full cycle — opened: ${openResult.debugUrl}`);

      // Verify active
      const activeCheck = await client.checkProfile(targetProfileId);
      expect(activeCheck.active).toBe(true);

      // Close
      await client.closeProfile(targetProfileId);
      await new Promise((r) => setTimeout(r, 2000));

      // Verify inactive
      const inactiveCheck = await client.checkProfile(targetProfileId);
      expect(inactiveCheck.active).toBe(false);
      console.log(`[smoke] Full cycle — complete`);
    })
  );
});
