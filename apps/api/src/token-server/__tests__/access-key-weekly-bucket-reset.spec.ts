import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { AccessKeyStore } from "../access-key-store";
import { UNIVERSAL_BILLING } from "../token-billing";

let tmp: string;
let ksPath: string;
let nowVal: number;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akw-reset-"));
  ksPath = path.join(tmp, "access-keys.json");
  nowVal = Date.parse("2026-06-01T00:00:00.000Z");
  vi.spyOn(Date, "now").mockImplementation(() => nowVal);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeStore(card: any) {
  fs.writeFileSync(ksPath, JSON.stringify({ keys: [card] }));
  return new AccessKeyStore(ksPath, UNIVERSAL_BILLING);
}

describe("AccessKeyStore publicStatus weekly bucket reset", () => {
  it("carries the precise weekly reset time on each weekly bucket", () => {
    const s = makeStore({
      id: "k",
      key: "ks",
      status: "active",
      provider: "anthropic",
      windowStartedAt: nowVal,
      weeklyWindowStartedAt: nowVal,
      bucketLimits: { "anthropic-claude": 1000 },
    });
    nowVal += 2 * 60 * 60 * 1000;

    const st = s.publicStatus(s.findById("k")!, 0, () => 3) as any;
    const wb = (st.weeklyBuckets || []).find((b: any) => b.bucket === "anthropic-claude");
    const wantResetMs = 7 * 24 * 60 * 60 * 1000 - 2 * 60 * 60 * 1000;

    expect(wb.weeklyWindowResetMs).toBe(wantResetMs);
    expect(wb.weeklyWindowResetAt).toBe(new Date(nowVal + wantResetMs).toISOString());
  });
});
