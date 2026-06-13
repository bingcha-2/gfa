import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { AccessKeyStore } from "../access-key-store";
import { recentBucketUsage, recentWeeklyBucketUsage } from "../token-billing";
import { cardIdSessionResolver, sessionReqFor } from "./session-test-util";

const sumUsage = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);

let lastStorePath = "";

function makeStore(keys: any[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aks-deshadow-"));
  const p = path.join(dir, "access-keys.json");
  fs.writeFileSync(p, JSON.stringify({ keys, updatedAt: "" }));
  lastStorePath = p;
  return new AccessKeyStore(p);
}

describe("AccessKeyStore.loadSubscriptionRecords (去影子:DB 订阅注册内存,不写文件)", () => {
  it("注册新订阅配置 record → findById 可取", () => {
    const store = makeStore([]);

    store.loadSubscriptionRecords([
      {
        id: "sub-1",
        status: "active",
        products: ["anthropic"],
        bucketLimits: { "anthropic-claude": 50000 },
        weeklyTokenLimit: 250000,
        windowMs: 18000000,
      } as any,
    ]);

    expect(store.findById("sub-1")).toMatchObject({
      id: "sub-1",
      status: "active",
      bucketLimits: { "anthropic-claude": 50000 },
    });
  });

  it("listSubscriptionRecords 返回所有已注册订阅 record(去影子:运行时限额从内存读,不读文件)", () => {
    const store = makeStore([{ id: "old-card", key: "k", status: "active" }]);
    store.loadSubscriptionRecords([
      { id: "sub-a", status: "active", bucketLimits: { "anthropic-claude": 1 } } as any,
      { id: "sub-b", status: "active", bindings: { anthropic: 7 }, weight: 8 } as any,
    ]);

    const list = store.listSubscriptionRecords();
    expect(list.map((r) => r.id).sort()).toEqual(["sub-a", "sub-b"]);
    // 文件卡不在订阅表里(两套独立)。
    expect(list.find((r) => r.id === "old-card")).toBeUndefined();
  });

  it("已存在同 id(有用量)→ 刷新配置、保留用量窗口(配置变更不清零限额)", () => {
    const store = makeStore([]);
    store.loadSubscriptionRecords([
      { id: "sub-1", status: "active", bucketLimits: { "anthropic-claude": 10000 } } as any,
    ]);
    const before = store.findById("sub-1") as any;
    before.tokenUsageEvents = [{ at: 1, tokens: 5 }]; // 模拟用量累积

    store.loadSubscriptionRecords([
      {
        id: "sub-1",
        status: "active",
        bucketLimits: { "anthropic-claude": 99999 },
        windowMs: 18000000,
      } as any,
    ]);

    const rec = store.findById("sub-1") as any;
    expect(rec.bucketLimits).toEqual({ "anthropic-claude": 99999 }); // 配置刷新
    expect(rec.tokenUsageEvents).toEqual([{ at: 1, tokens: 5 }]); // 用量保留
  });
});

describe("去影子运行时:限额只走 subscriptionById(record 仅在内存,文件全程不写)", () => {
  it("仅注册进内存(文件空)的订阅 → 会话路径能 resolve、能按 bucketLimits 限额、文件始终不被写", async () => {
    const store = makeStore([]); // 文件无任何卡
    store.setSessionResolver(cardIdSessionResolver);
    store.loadSubscriptionRecords([
      {
        id: "sub-runtime",
        status: "active",
        products: ["anthropic"],
        bucketLimits: { "anthropic-claude": 100 },
        windowMs: 18_000_000,
      } as any,
    ]);

    // 额度内:resolve 命中内存订阅 record(byId 文件索引为空,只能来自 subscriptionById)。
    const ok = await store.resolveFromRequest(sessionReqFor("sub-runtime"), {}, {
      enforceLimit: true, modelKey: "claude-opus-4", product: "anthropic",
    });
    expect(ok.record?.id).toBe("sub-runtime");
    expect(ok.viaSession).toBe(true);

    // 把该桶用满 → 下一次同桶请求 429(限额确实从内存 record 的 bucketLimits 生效)。
    store.recordUsage("sub-runtime", 200, { totalTokens: 100, rawTotalTokens: 100 }, "claude-opus-4", "r1", "anthropic");
    const blocked = await store.resolveFromRequest(sessionReqFor("sub-runtime"), {}, {
      enforceLimit: true, modelKey: "claude-opus-4", product: "anthropic",
    });
    expect(blocked.limitExceeded).toBe(true);
    expect(blocked.record).toBeNull();

    // 文件全程没被写(去影子:订阅 record 不进 access-keys.json)。
    store.flush();
    expect(JSON.parse(fs.readFileSync(lastStorePath, "utf8")).keys).toEqual([]);
  });
});

describe("AccessKeyStore.reload 与订阅 record 协同(去影子 reload 陷阱)", () => {
  it("reload(管理员改文件触发)后,订阅 record 不被文件重载冲掉(配置+用量都保留)", () => {
    // 文件里只有一张老卡;订阅 record 来自 DB(不在文件)。
    const store = makeStore([{ id: "old-card", key: "k", status: "active" }]);
    store.loadSubscriptionRecords([
      { id: "sub-1", status: "active", bucketLimits: { "anthropic-claude": 50000 } } as any,
    ]);
    const rec = store.findById("sub-1") as any;
    rec.tokenUsageEvents = [{ at: 1, tokens: 5 }]; // 模拟已累积用量

    store.reload(); // 管理员改卡触发的文件重载

    const after = store.findById("sub-1") as any;
    expect(after, "订阅 record 不应被文件重载清掉").toBeTruthy();
    expect(after.bucketLimits).toEqual({ "anthropic-claude": 50000 }); // 配置在
    expect(after.tokenUsageEvents).toEqual([{ at: 1, tokens: 5 }]); // 用量在(否则限额清零→白嫖)
    expect(store.findById("old-card"), "老卡也仍在").toBeTruthy();
  });
});

describe("D2 去影子:订阅 record 窗口起点跨重启重建(hydrate 后回放,防穿透)", () => {
  const FIVE_H = 18_000_000;
  const HOUR = 60 * 60 * 1000;

  it("号池订阅 boot 后:5h + 周窗口起点从用量回放重建,额度不被清零", () => {
    const now = Date.now();
    const store = makeStore([]);
    store.loadSubscriptionRecords([{
      id: "pool-1", key: "BK-POOL", customerId: "c1", status: "active",
      products: ["antigravity"], bucketLimits: { "antigravity-gemini": 1_000_000 },
      windowMs: FIVE_H,
    } as any]);
    // 模拟 boot:hydrate 灌入窗口内(1h 前)的一条用量。
    store.hydrateWindowsFromUsageLog([{
      accessKeyId: "pool-1", at: now - HOUR, status: 200,
      modelKey: "gemini-2.5-pro", bucket: "antigravity-gemini",
      inputTokens: 3000, outputTokens: 2000, rawTotalTokens: 5000, totalTokens: 5000,
    }]);

    const rec = store.findById("pool-1") as any;
    // 起点被重建为事件时刻(而非 0)→ 不会被 resetWindowIfExpired 当过期清空。
    expect(rec.windowStartedAt).toBe(now - HOUR);
    expect(rec.weeklyWindowStartedAt).toBe(now - HOUR);
    expect(rec.tokenUsageEvents).toHaveLength(1);
    // recentBucketUsage 内部会 resetWindowIfExpired;若起点没重建会清零 → 这里证明额度连续。
    expect(sumUsage(recentBucketUsage(rec, now))).toBeGreaterThan(0);
    expect(sumUsage(recentWeeklyBucketUsage(rec, now))).toBeGreaterThan(0);
  });

  it("5h 已过期但仍在周窗内:5h 重置为空、周窗口保留(各按自己窗长回放)", () => {
    const now = Date.now();
    const store = makeStore([]);
    store.loadSubscriptionRecords([{
      id: "pool-2", key: "BK-POOL2", customerId: "c1", status: "active",
      products: ["antigravity"], bucketLimits: { "antigravity-gemini": 1_000_000 },
      windowMs: FIVE_H,
    } as any]);
    // 6h 前的用量:超出 5h 窗,但在 7 天周窗内。
    store.hydrateWindowsFromUsageLog([{
      accessKeyId: "pool-2", at: now - 6 * HOUR, status: 200,
      modelKey: "gemini-2.5-pro", bucket: "antigravity-gemini",
      rawTotalTokens: 5000, totalTokens: 5000,
    }]);

    const rec = store.findById("pool-2") as any;
    // 5h 窗已过期 → 起点未设、事件清空(下次使用才开新窗)。
    expect(Number(rec.windowStartedAt || 0)).toBe(0);
    expect(rec.tokenUsageEvents).toHaveLength(0);
    // 周窗仍活 → 起点 = 事件时刻、事件保留。
    expect(rec.weeklyWindowStartedAt).toBe(now - 6 * HOUR);
    expect(rec.weeklyTokenUsageEvents).toHaveLength(1);
    expect(sumUsage(recentWeeklyBucketUsage(rec, now))).toBeGreaterThan(0);
  });

  it("绑定订阅:5h 不重建/不裁剪(走 alignedResetAt,事件保留),周窗口照常重建", () => {
    const now = Date.now();
    const store = makeStore([]);
    store.loadSubscriptionRecords([{
      id: "bind-1", key: "BK-BIND", customerId: "c1", status: "active",
      products: ["antigravity"], bindings: { antigravity: 7 }, weight: 1,
      requiresBinding: true, windowMs: FIVE_H,
    } as any]);
    // 两条:1h 前 + 6h 前。绑定卡 5h 靠 alignedResetAt 按上游窗过滤,故 tokenUsageEvents 不应被本逻辑裁剪。
    store.hydrateWindowsFromUsageLog([
      { accessKeyId: "bind-1", at: now - HOUR, status: 200, modelKey: "gemini-2.5-pro", bucket: "antigravity-gemini", rawTotalTokens: 1000, totalTokens: 1000 },
      { accessKeyId: "bind-1", at: now - 6 * HOUR, status: 200, modelKey: "gemini-2.5-pro", bucket: "antigravity-gemini", rawTotalTokens: 2000, totalTokens: 2000 },
    ]);

    const rec = store.findById("bind-1") as any;
    // 5h:绑定卡不读 windowStartedAt、不在此重建;两条事件全保留(交给 alignedResetAt 过滤)。
    expect(Number(rec.windowStartedAt || 0)).toBe(0);
    expect(rec.tokenUsageEvents).toHaveLength(2);
    // 周:两条都在 7 天内 → 起点 = 最早事件、两条都保留。
    expect(rec.weeklyWindowStartedAt).toBe(now - 6 * HOUR);
    expect(rec.weeklyTokenUsageEvents).toHaveLength(2);
  });
});
