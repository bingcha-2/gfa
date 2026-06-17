/**
 * deploy-quota-leak-repro.spec.ts
 *
 * 核实(只复现+量化,不修复)「每次部署都漏额度」:纯订阅卡(号池线 pool,正常下单、
 * 非卡迁移 → subscriptionToLimitRecord 产出的 record 不含 windowStartedAt)在服务重启后,
 * 5h 桶窗口与周窗口的起点随内存丢失。首次请求进 validateRecord 时,resetWindowIfExpired /
 * resetWeeklyWindowIfExpired 见「起点===0」即把整窗事件清空、起点重设为 now —— 已用满额度的
 * 卡被当作全新窗,本应 429 的请求被放行 = 每次部署用户重新白拿一整窗额度。
 *
 * 两个对照组,全程走真实生产 enforcement(resolveFromRequest, enforceLimit:true),不改任何生产逻辑:
 *
 *   ① PRE-D2(= committed HEAD 行为):复刻 D2 之前的 boot 态 —— loadSubscriptionRecords 不设
 *      窗口起点(现状),再以「老 hydrate 只 push 事件、不重建起点」的方式灌入满额用量(D2 之前的
 *      hydrateWindowsFromUsageLog 末尾没有 reconstructSubscriptionWindows)。→ 漏洞复现:放行。
 *
 *   ② POST-D2(= 当前 working tree,access-key-store.ts 的 reconstructSubscriptionWindows 已就位):
 *      改走真实 hydrateWindowsFromUsageLog(末尾回放重建起点)→ 同一份满额用量被正确拦截(429)。
 *
 * 覆盖:5h 桶(anthropic-claude · antigravity-gemini 原始计量 · codex-gpt CU 计量)
 *       + 周窗(显式 weeklyTokenLimit · 派生 5h×R),boot 重建对各桶完备(对齐子计划 D 的 D2-1)。
 *
 * 量化口径:opus 输出权重 = 5(@gfa/shared CLAUDE_TIER_WEIGHTS.opus.output);一条 400-输出事件
 *           = 400×5 = 2000 CU。桶/周上限设 1000 CU → 2000 ≥ 1000,窗口完好时必拦、窗口被清零时放行。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { AccessKeyStore } from "../access-key-store";
import { UNIVERSAL_BILLING } from "../token-billing";
import { cardIdSessionResolver, sessionReqFor } from "./session-test-util";

const FIVE_H = 5 * 60 * 60 * 1000; // 18_000_000;与 subscriptionToLimitRecord 透传的 windowMs 一致
const HOUR = 60 * 60 * 1000;
const CAP = 1000; // 桶/周上限(CU)
const OVER_OUTPUT = 400; // 400 输出 × opus 权重 5 = 2000 CU ≥ CAP

let nowVal: number;
const tmpDirs: string[] = [];
const stores: AccessKeyStore[] = [];

beforeEach(() => {
  // 固定时钟:validateRecord / resetWindowIfExpired / reconstruct 内部都用 Date.now(),锁住它
  // 才能对窗口起点做精确断言、并让复现稳定(不随真实墙钟漂移)。
  nowVal = Date.parse("2026-06-01T00:00:00.000Z");
  vi.spyOn(Date, "now").mockImplementation(() => nowVal);
});

afterEach(() => {
  // flush 清掉 markDirty 排的 10s debounce 定时器(被拦请求会 writeCache → markDirty)。
  for (const s of stores.splice(0)) {
    try { s.flush(); } catch { /* ignore */ }
  }
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** 空文件 + 注入会话解析桩(订阅卡只能经 session-JWT 走 resolveFromRequest)。 */
function makeStore(): AccessKeyStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-leak-"));
  tmpDirs.push(dir);
  const p = path.join(dir, "access-keys.json");
  fs.writeFileSync(p, JSON.stringify({ keys: [], updatedAt: "" }));
  const s = new AccessKeyStore(p, UNIVERSAL_BILLING);
  s.setSessionResolver(cardIdSessionResolver);
  stores.push(s);
  return s;
}

/** 一条「窗口内 1h 前、已超额(2000 CU)」的满额用量事件。形如 CardTokenUsage 行。 */
function fullUsageRow(id: string) {
  return {
    accessKeyId: id,
    at: nowVal - HOUR,
    status: 200,
    modelKey: "claude-opus-4",
    bucket: "anthropic-claude",
    inputTokens: 0,
    outputTokens: OVER_OUTPUT,
    cachedInputTokens: 0,
    rawTotalTokens: OVER_OUTPUT * 5,
    totalTokens: OVER_OUTPUT * 5,
  };
}

/** D2 之前的 hydrate 等价物:只把行 push 进两条事件数组、不重建窗口起点(对照现行
 *  hydrateWindowsFromUsageLog —— 现行版本末尾会调 reconstructSubscriptionWindows)。
 *  product 由 bucket 前缀反推,与真实 hydrate 的口径一致。 */
function legacyHydratePushOnly(rec: any, rows: any[]) {
  rec.tokenUsageEvents = rec.tokenUsageEvents || [];
  rec.weeklyTokenUsageEvents = rec.weeklyTokenUsageEvents || [];
  for (const row of rows) {
    const bucket = String(row.bucket || "");
    const product = bucket.includes("-") ? bucket.slice(0, bucket.indexOf("-")) : "";
    const ev = {
      at: row.at, status: row.status,
      inputTokens: row.inputTokens, outputTokens: row.outputTokens,
      cachedInputTokens: row.cachedInputTokens,
      rawTotalTokens: row.rawTotalTokens, totalTokens: row.totalTokens,
      modelKey: row.modelKey, product,
    };
    rec.tokenUsageEvents.push(ev);
    rec.weeklyTokenUsageEvents.push(ev);
  }
}

/** 真实请求 enforcement 入口。allowed ⟺ 命中 record 且未超额。 */
async function resolve(
  store: AccessKeyStore,
  id: string,
  opts: { modelKey?: string; product?: string; weeklyRatio?: number } = {},
) {
  return store.resolveFromRequest(sessionReqFor(id), {}, {
    enforceLimit: true,
    modelKey: opts.modelKey ?? "claude-opus-4",
    product: opts.product ?? "anthropic",
    ...(opts.weeklyRatio !== undefined ? { weeklyRatio: opts.weeklyRatio } : {}),
  });
}

// ───────────────────────────────────────────────────────────────────────────
// ① PRE-D2(committed HEAD 行为):窗口起点丢失 → 首次请求清零 → 放行。漏洞复现。
// ───────────────────────────────────────────────────────────────────────────
describe("漏洞复现(PRE-D2 / HEAD):重启后纯订阅卡首次请求把满额窗口清零并放行", () => {
  it("5h 桶:windowStartedAt 丢失 → resetWindowIfExpired 清空满桶事件 → 本应 429 的请求被放行", async () => {
    const store = makeStore();
    // 号池订阅 record:subscriptionToLimitRecord 的产物形状,关键是「无 windowStartedAt」。
    store.loadSubscriptionRecords([{
      id: "pool-5h", key: "BK-5H", customerId: "c1", status: "active",
      products: ["anthropic"], bucketLimits: { "anthropic-claude": CAP },
      windowMs: FIVE_H,
    } as any]);
    const rec = store.findById("pool-5h") as any;
    legacyHydratePushOnly(rec, [fullUsageRow("pool-5h")]); // 满桶(2000 CU)灌入,起点仍未设

    // boot 后状态:事件在、起点为 0(=「丢失」)。
    expect(rec.tokenUsageEvents).toHaveLength(1);
    expect(Number(rec.windowStartedAt || 0)).toBe(0);

    const res = await resolve(store, "pool-5h");

    // 漏洞:满桶卡被放行(record 命中、未标超额)。
    expect(res.limitExceeded).toBeFalsy();
    expect(res.record?.id).toBe("pool-5h");
    // 证据:整窗被清空、起点被重设为 now(用户拿到全新 5h 窗)。
    expect(rec.tokenUsageEvents).toHaveLength(0);
    expect(rec.windowStartedAt).toBe(nowVal);
  });

  it("周窗:weeklyWindowStartedAt 丢失 → resetWeeklyWindowIfExpired 清空满额事件 → 放行", async () => {
    const store = makeStore();
    // 显式周限、无 5h 桶上限 → 只有周这一道闸,干净隔离周窗口。
    store.loadSubscriptionRecords([{
      id: "pool-wk", key: "BK-WK", customerId: "c1", status: "active",
      products: ["anthropic"], weeklyTokenLimit: CAP, windowMs: FIVE_H,
    } as any]);
    const rec = store.findById("pool-wk") as any;
    legacyHydratePushOnly(rec, [fullUsageRow("pool-wk")]); // 满周额(2000 CU),周起点未设

    expect(rec.weeklyTokenUsageEvents).toHaveLength(1);
    expect(Number(rec.weeklyWindowStartedAt || 0)).toBe(0);

    const res = await resolve(store, "pool-wk");

    expect(res.limitExceeded).toBeFalsy();
    expect(res.record?.id).toBe("pool-wk");
    // 证据:周窗事件被清空、周起点重设为 now(用户拿到全新一周额度)。
    expect(rec.weeklyTokenUsageEvents).toHaveLength(0);
    expect(rec.weeklyWindowStartedAt).toBe(nowVal);
  });

  it("周窗 · 派生 5h×R(池子卡无显式 weeklyTokenLimit):derived 周上限也随起点丢失被清零 → 放行", async () => {
    const store = makeStore();
    store.loadSubscriptionRecords([{
      id: "pool-der", key: "BK-DER", customerId: "c1", status: "active",
      products: ["anthropic"], bucketLimits: { "anthropic-claude": CAP }, windowMs: FIVE_H,
      // 无 weeklyTokenLimit → 周上限派生 = 5h(CAP) × R(下方传 2)= 2000
    } as any]);
    const rec = store.findById("pool-der") as any;
    // 跨两个 5h 窗:7h 前 1500 CU + 1h 前 600 CU;周共 2100 CU(> 2000)。
    legacyHydratePushOnly(rec, [
      { at: nowVal - 7 * HOUR, status: 200, modelKey: "claude-opus-4", bucket: "anthropic-claude", inputTokens: 0, outputTokens: 300, cachedInputTokens: 0, rawTotalTokens: 1500, totalTokens: 1500 },
      { at: nowVal - HOUR, status: 200, modelKey: "claude-opus-4", bucket: "anthropic-claude", inputTokens: 0, outputTokens: 120, cachedInputTokens: 0, rawTotalTokens: 600, totalTokens: 600 },
    ]);
    expect(rec.weeklyTokenUsageEvents).toHaveLength(2);
    expect(Number(rec.weeklyWindowStartedAt || 0)).toBe(0);

    const res = await resolve(store, "pool-der", { weeklyRatio: 2 });

    expect(res.limitExceeded).toBeFalsy();
    expect(res.record?.id).toBe("pool-der");
    expect(rec.weeklyTokenUsageEvents).toHaveLength(0);
    expect(rec.weeklyWindowStartedAt).toBe(nowVal);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ② POST-FIX(当前 working tree):重启从持久化窗口快照(Subscription.windowState)
//    精准恢复起点 → 同一满额用量被正确拦截。模拟重启 = 全新 store + restoreSubscriptionWindow。
// ───────────────────────────────────────────────────────────────────────────

/** hydrate 当年存进事件数组的形状(product 由 bucket 前缀反推)。 */
function storedEvent(row: any) {
  const bucket = String(row.bucket || "");
  const product = bucket.includes("-") ? bucket.slice(0, bucket.indexOf("-")) : "";
  return {
    at: row.at, status: row.status ?? 200,
    inputTokens: row.inputTokens ?? 0, outputTokens: row.outputTokens ?? 0,
    cachedInputTokens: row.cachedInputTokens ?? 0,
    rawTotalTokens: row.rawTotalTokens ?? 0, totalTokens: row.totalTokens ?? 0,
    modelKey: row.modelKey ?? "", product,
  };
}

/** 模拟重启:全新 store 注册订阅配置 + 从 windowState 快照恢复窗口(起点 + 窗口内事件)。 */
function bootRestore(cfg: any, snapshot: {
  windowStartedAt?: number; weeklyWindowStartedAt?: number;
  tokenUsageEvents?: any[]; weeklyTokenUsageEvents?: any[];
}): AccessKeyStore {
  const store = makeStore();
  store.loadSubscriptionRecords([cfg]);
  store.restoreSubscriptionWindow(cfg.id, JSON.stringify({
    windowStartedAt: snapshot.windowStartedAt ?? 0,
    weeklyWindowStartedAt: snapshot.weeklyWindowStartedAt ?? 0,
    tokenUsageEvents: snapshot.tokenUsageEvents ?? [],
    weeklyTokenUsageEvents: snapshot.weeklyTokenUsageEvents ?? [],
  }));
  return store;
}

describe("修复后(POST-FIX / working tree):重启从 windowState 精准恢复起点 → 满额请求 429", () => {
  it("5h 桶:windowStartedAt 从快照恢复 → 满桶请求被拦(429,limitExceeded)", async () => {
    const ev = storedEvent(fullUsageRow("pool-5h"));
    const store = bootRestore(
      { id: "pool-5h", key: "BK-5H", customerId: "c1", status: "active", products: ["anthropic"], bucketLimits: { "anthropic-claude": CAP }, windowMs: FIVE_H },
      { windowStartedAt: nowVal - HOUR, weeklyWindowStartedAt: nowVal - HOUR, tokenUsageEvents: [ev], weeklyTokenUsageEvents: [ev] },
    );
    const rec = store.findById("pool-5h") as any;
    expect(rec.windowStartedAt).toBe(nowVal - HOUR);
    expect(rec.tokenUsageEvents).toHaveLength(1);

    const res = await resolve(store, "pool-5h");
    expect(res.limitExceeded).toBe(true);
    expect(res.record).toBeNull();
    expect(res.error).toMatch(/token limit exceeded/);
    expect(res.error).toContain("/5h"); // 5h 窗口(非 weekly)
    expect(Number(res.resetMs || 0)).toBeGreaterThan(0);
  });

  it("周窗:weeklyWindowStartedAt 从快照恢复 → 满额周请求被拦(429,weekly)", async () => {
    const ev = storedEvent(fullUsageRow("pool-wk"));
    const store = bootRestore(
      { id: "pool-wk", key: "BK-WK", customerId: "c1", status: "active", products: ["anthropic"], weeklyTokenLimit: CAP, windowMs: FIVE_H },
      { windowStartedAt: nowVal - HOUR, weeklyWindowStartedAt: nowVal - HOUR, tokenUsageEvents: [ev], weeklyTokenUsageEvents: [ev] },
    );
    const rec = store.findById("pool-wk") as any;
    expect(rec.weeklyWindowStartedAt).toBe(nowVal - HOUR);
    expect(rec.weeklyTokenUsageEvents).toHaveLength(1);

    const res = await resolve(store, "pool-wk");
    expect(res.limitExceeded).toBe(true);
    expect(res.record).toBeNull();
    expect(res.error).toMatch(/weekly token limit exceeded/);
    expect(Number(res.resetMs || 0)).toBeGreaterThan(0);
  });

  it("5h 桶 · antigravity-gemini(原始计量,非 CU):快照恢复起点 → 满桶 429", async () => {
    const ev = storedEvent({ at: nowVal - HOUR, modelKey: "gemini-2.5-pro", bucket: "antigravity-gemini", rawTotalTokens: 2000, totalTokens: 2000 });
    const store = bootRestore(
      { id: "pool-gem", key: "BK-GEM", customerId: "c1", status: "active", products: ["antigravity"], bucketLimits: { "antigravity-gemini": CAP }, windowMs: FIVE_H },
      { windowStartedAt: nowVal - HOUR, weeklyWindowStartedAt: nowVal - HOUR, tokenUsageEvents: [ev], weeklyTokenUsageEvents: [ev] },
    );
    const rec = store.findById("pool-gem") as any;
    expect(rec.windowStartedAt).toBe(nowVal - HOUR);
    expect(rec.tokenUsageEvents).toHaveLength(1);

    const res = await resolve(store, "pool-gem", { modelKey: "gemini-2.5-pro", product: "antigravity" });
    expect(res.limitExceeded).toBe(true);
    expect(res.record).toBeNull();
    expect(res.error).toMatch(/token limit exceeded/);
    expect(res.error).toContain("/5h");
  });

  it("5h 桶 · codex-gpt(CU 计量):快照恢复起点 → 满桶 429", async () => {
    const ev = storedEvent({ at: nowVal - HOUR, modelKey: "gpt-5-codex", bucket: "codex-gpt", totalTokens: 2000 });
    const store = bootRestore(
      { id: "pool-cdx", key: "BK-CDX", customerId: "c1", status: "active", products: ["codex"], bucketLimits: { "codex-gpt": CAP }, windowMs: FIVE_H },
      { windowStartedAt: nowVal - HOUR, weeklyWindowStartedAt: nowVal - HOUR, tokenUsageEvents: [ev], weeklyTokenUsageEvents: [ev] },
    );
    const rec = store.findById("pool-cdx") as any;
    expect(rec.windowStartedAt).toBe(nowVal - HOUR);
    expect(rec.tokenUsageEvents).toHaveLength(1);

    const res = await resolve(store, "pool-cdx", { modelKey: "gpt-5-codex", product: "codex" });
    expect(res.limitExceeded).toBe(true);
    expect(res.record).toBeNull();
    expect(res.error).toMatch(/token limit exceeded/);
    expect(res.error).toContain("/5h");
  });

  it("周窗 · 派生 5h×R(池子卡无显式 weeklyTokenLimit):快照恢复周起点 → 周超 429(5h 未超)", async () => {
    // 5h 当前窗只留 1h 前 600 CU(7h 前那条已出窗);周窗保留两条(7 天内),共 4300。
    const inWindow = storedEvent({ at: nowVal - HOUR, modelKey: "claude-opus-4", bucket: "anthropic-claude", outputTokens: 120, rawTotalTokens: 600, totalTokens: 600 });
    const older = storedEvent({ at: nowVal - 7 * HOUR, modelKey: "claude-opus-4", bucket: "anthropic-claude", outputTokens: 740, rawTotalTokens: 3700, totalTokens: 3700 });
    const store = bootRestore(
      { id: "pool-der", key: "BK-DER", customerId: "c1", status: "active", products: ["anthropic"], bucketLimits: { "anthropic-claude": CAP }, windowMs: FIVE_H },
      { windowStartedAt: nowVal - HOUR, weeklyWindowStartedAt: nowVal - 7 * HOUR, tokenUsageEvents: [inWindow], weeklyTokenUsageEvents: [older, inWindow] },
    );
    const rec = store.findById("pool-der") as any;
    expect(rec.windowStartedAt).toBe(nowVal - HOUR);
    expect(rec.tokenUsageEvents).toHaveLength(1);
    expect(rec.weeklyWindowStartedAt).toBe(nowVal - 7 * HOUR);
    expect(rec.weeklyTokenUsageEvents).toHaveLength(2);

    const res = await resolve(store, "pool-der", { weeklyRatio: 2 });
    // 5h 当前窗 600 < 1000(不触 5h 闸)→ 进周闸;周 4300 ≥ 3752(=1000×3.752)→ 拦。
    expect(res.limitExceeded).toBe(true);
    expect(res.record).toBeNull();
    expect(res.error).toMatch(/weekly token limit exceeded/);
    expect(Number(res.resetMs || 0)).toBeGreaterThan(0);
  });
});
