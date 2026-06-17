import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { AccessKeyStore } from "../access-key-store";
import { UNIVERSAL_BILLING } from "../token-billing";
import { cardIdSessionResolver, sessionReqFor } from "./session-test-util";

// 派生周上限(批次 B2):anthropic/codex 桶若未显式设 weeklyTokenLimit,周上限 = 5h上限 × R。
// R 由调用方(lease-service)经 options.weeklyRatio 回调解析(卡设置框 > 学习 > 全局默认)。
const FIVE_H = 5 * 60 * 60 * 1000;
let tmp: string;
let ksPath: string;
let nowVal: number;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akw-"));
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
  const s = new AccessKeyStore(ksPath, UNIVERSAL_BILLING);
  // 卡密运行时凭证已移除:经 session-JWT 桩解析(token.cardId → record id)走同一条校验管线。
  s.setSessionResolver(cardIdSessionResolver);
  return s;
}
// 一条 opus 100-输出 token 事件 = 100×5 = 500 CU。
function out500(s: AccessKeyStore, rid: string) {
  s.recordUsage("k", 200, { inputTokens: 0, outputTokens: 100 }, "claude-opus-4", rid, "anthropic");
}
// 跨 4 个 5h 窗口各记 500 CU:每次 roll 掉 5h、周累计 → 周=2000,5h=500。
function build4Windows(s: AccessKeyStore) {
  out500(s, "r1"); nowVal += FIVE_H + 1;
  out500(s, "r2"); nowVal += FIVE_H + 1;
  out500(s, "r3"); nowVal += FIVE_H + 1;
  out500(s, "r4");
}
function resolve(s: AccessKeyStore, weeklyRatio: (rec: any) => number) {
  return s.resolveFromRequest(
    sessionReqFor("k"),
    {},
    { enforceLimit: true, modelKey: "claude-opus-4", product: "anthropic", weeklyRatio },
  );
}

describe("派生周上限 = 5h上限 × R(anthropic/codex)", () => {
  const base = { id: "k", key: "ks", status: "active", provider: "anthropic" };

  it("weeklyRatio below 3.752 is floored, so 2000 CU is allowed against a derived 3752 CU weekly cap", async () => {
    const s = makeStore({ ...base, windowStartedAt: nowVal, weeklyWindowStartedAt: nowVal, bucketLimits: { "anthropic-claude": 1000 } });
    build4Windows(s); // 周=2000, 5h=500
    const res = await resolve(s, () => 2);
    expect(res.record).not.toBeNull();
    expect(res.limitExceeded).toBeFalsy();
  });

  it("卡设置框 weeklyRatio 覆盖(R=10 → 周=10000)→ 同样用量不拦", async () => {
    const s = makeStore({ ...base, weeklyRatio: 10, windowStartedAt: nowVal, weeklyWindowStartedAt: nowVal, bucketLimits: { "anthropic-claude": 1000 } });
    build4Windows(s);
    // 模拟 lease-service 的回调:卡设置框优先
    const res = await resolve(s, (rec) => Number(rec.weeklyRatio || 0) || 5);
    expect(res.record).not.toBeNull(); // 周=10000 > 2000 用量
  });

  it("无 5h 上限(bucketLimits 留空)→ 不派生周,不拦", async () => {
    const s = makeStore({ ...base, windowStartedAt: nowVal, weeklyWindowStartedAt: nowVal });
    build4Windows(s);
    const res = await resolve(s, () => 2);
    expect(res.record).not.toBeNull();
  });

  it("publicStatus 派生周桶:池子卡 bucketLimits → weeklyBuckets 含 5h×R", () => {
    const s = makeStore({ ...base, windowStartedAt: nowVal, weeklyWindowStartedAt: nowVal, bucketLimits: { "anthropic-claude": 1000 } });
    out500(s, "r1"); // 5h & 周 各 500 CU
    const st = s.publicStatus(s.findById("k")!, 0, () => 3) as any; // clamped to R=3.752
    const wb = (st.weeklyBuckets || []).find((b: any) => b.bucket === "anthropic-claude");
    expect(wb).toBeDefined();
    expect(wb.limit).toBe(3752); // 1000 × 3.752
    expect(wb.used).toBe(500);
    // 5h 桶照旧
    const fh = (st.buckets || []).find((b: any) => b.bucket === "anthropic-claude");
    expect(fh.limit).toBe(1000);
    expect(fh.used).toBe(500);
  });

  it("显式 weeklyTokenLimit 独立生效(无 bucketLimits → 不派生,只用显式周限)", async () => {
    // 显式周限 1500、无 5h 上限:派生分支不触发(cap5h=0),走显式分支 → 用量 2000 ≥ 1500 拦。
    const s = makeStore({ ...base, windowStartedAt: nowVal, weeklyWindowStartedAt: nowVal, weeklyTokenLimit: 1500 });
    build4Windows(s);
    const res = await resolve(s, () => 2);
    expect(res.record).toBeNull();
    expect(res.error).toContain("weekly");
  });
});
