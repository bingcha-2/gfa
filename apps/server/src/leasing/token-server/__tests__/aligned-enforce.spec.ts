import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccessKeyStore } from "../access-key-store";
import { cardIdSessionResolver, sessionReqFor } from "./session-test-util";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Bound-card limit windows align to the bound account's upstream reset
 * (`alignedResetAt`): usage in the current aligned window counts, and when the
 * account window rolls (now crosses the reset boundary), pre-boundary usage no
 * longer counts. resolveFromRequest uses Date.now() internally, so we pin the
 * per-bucket window start and pick alignedResetAt relative to "now".
 */
describe("resolveFromRequest — aligned (bound) bucket window", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-aligned-"));
    filePath = path.join(tmpDir, "access-keys.json");
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  function makeStore(card: any) {
    writeJson(filePath, { keys: [card] });
    const store = new AccessKeyStore(filePath);
    store.setSessionResolver(cardIdSessionResolver);
    return store;
  }

  const REQ = sessionReqFor("k1");

  it("counts usage inside the current aligned window → over limit", async () => {
    const now = Date.now();
    const store = makeStore({
      id: "k1", key: "secret1", status: "active",
      bucketLimits: { "anthropic-claude": 500_000 },
      bucketWindowStartedAt: { "anthropic-claude": now - 2000 }, // window opened 2s ago
      tokenUsageEvents: [
        { at: now - 1000, inputTokens: 300_000, outputTokens: 200_001, modelKey: "claude-sonnet-4-6", product: "anthropic" },
      ],
    });
    const result = await store.resolveFromRequest(REQ, {}, {
      enforceLimit: true, modelKey: "claude-sonnet-4-6", product: "anthropic",
      alignedResetAt: now + 10_000, // account window resets far in the future → no roll
    });
    expect(result.record).toBeNull();
    expect(result.limitExceeded).toBe(true);
  });

  it("publicStatus reports the account-aligned reset so the client window aligns", async () => {
    const store = makeStore({
      id: "k1", key: "secret1", status: "active",
      bucketLimits: { "anthropic-claude": 500_000 },
    });
    const record = store.findById("k1")!;
    const aligned = Date.now() + 100_000; // account resets in 100s

    const status = store.publicStatus(record, aligned);
    // client back-derives its window end from this → must reflect the account window,
    // not the default 5h global window.
    expect(status.tokenWindowResetMs).toBeGreaterThan(95_000);
    expect(status.tokenWindowResetMs).toBeLessThanOrEqual(100_000);

    // without alignment (pool card) → the global window (default 5h), far larger
    const poolStatus = store.publicStatus(record);
    expect(poolStatus.tokenWindowResetMs).toBeGreaterThan(1_000_000);
  });

  it("publicStatus with alignment is read-only and reports aligned bucket usage", () => {
    const now = Date.now();
    const store = makeStore({
      id: "k1", key: "secret1", status: "active",
      bucketLimits: { "anthropic-claude": 500_000 },
      windowStartedAt: now - 6 * 60 * 60 * 1000,
      bucketWindowStartedAt: { "anthropic-claude": now - 2000 },
      tokenUsageEvents: [
        { at: now - 1000, inputTokens: 100_000, outputTokens: 50_000, modelKey: "claude-sonnet-4-6", product: "anthropic" },
      ],
    });
    const record = store.findById("k1")!;
    const status = store.publicStatus(record, now + 100_000);
    const bucket = status.buckets.find((b: any) => b.bucket === "anthropic-claude");

    expect(bucket.used).toBe(210_000);
    expect(record.tokenUsageEvents).toHaveLength(1);
  });

  it("drops pre-boundary usage once the account window rolls → under limit again", async () => {
    const now = Date.now();
    const store = makeStore({
      id: "k1", key: "secret1", status: "active",
      bucketLimits: { "anthropic-claude": 500_000 },
      bucketWindowStartedAt: { "anthropic-claude": now - 2000 },
      tokenUsageEvents: [
        { at: now - 1000, inputTokens: 300_000, outputTokens: 200_001, modelKey: "claude-sonnet-4-6", product: "anthropic" },
      ],
    });
    const result = await store.resolveFromRequest(REQ, {}, {
      enforceLimit: true, modelKey: "claude-sonnet-4-6", product: "anthropic",
      alignedResetAt: now - 500, // boundary after window-start, before now → rolls; old event excluded
    });
    expect(result.record).not.toBeNull();
    expect(result.limitExceeded).toBeFalsy();
  });
});
