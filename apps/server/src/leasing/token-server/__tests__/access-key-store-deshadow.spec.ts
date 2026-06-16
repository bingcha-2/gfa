import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { AccessKeyStore } from "../access-key-store";
import { cardIdSessionResolver, sessionReqFor } from "./session-test-util";

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

describe("AccessKeyStore.subscriptionsBoundToAccount(用量看板把订阅列为绑定项;限流路径不变)", () => {
  it("只认绑定到该号的 active 订阅;expired / 号池(无 bindings)/ 别的号 / 别的产品都排除", () => {
    // 文件里一张绑到号 1 的老卡,DB 侧若干订阅。
    const store = makeStore([
      { id: "file-card", key: "k", status: "active", bindings: { antigravity: 1 } } as any,
    ]);
    store.loadSubscriptionRecords([
      { id: "sub-bound", status: "active", bindings: { antigravity: 1 }, weight: 4 } as any,
      { id: "sub-other-acct", status: "active", bindings: { antigravity: 2 }, weight: 1 } as any,
      { id: "sub-other-prod", status: "active", bindings: { codex: 1 }, weight: 1 } as any,
      { id: "sub-expired", status: "expired", bindings: { antigravity: 1 }, weight: 1 } as any,
      { id: "sub-pool", status: "active", bucketLimits: { "antigravity-gemini": 1 } } as any,
    ]);

    // 看板路径:号 1 / antigravity 只命中 sub-bound(active + bindings 命中)。
    // (文件卡发号已退役,cardsBoundToAccount 死函数已删 —— 看板只列订阅。)
    expect(store.subscriptionsBoundToAccount(1, "antigravity")).toEqual(["sub-bound"]);
  });

  it("accountId <= 0 → 空", () => {
    const store = makeStore([]);
    store.loadSubscriptionRecords([{ id: "s", status: "active", bindings: { antigravity: 1 } } as any]);
    expect(store.subscriptionsBoundToAccount(0, "antigravity")).toEqual([]);
  });
});

describe("AccessKeyStore 订阅窗口持久化(serialize / restore;重启精准恢复,回放跳过)", () => {
  it("serialize → restore 往返:5h/周 起点 + 窗口内事件原样恢复", () => {
    const store = makeStore([]);
    store.loadSubscriptionRecords([{ id: "sub-1", status: "active", windowMs: 18000000 } as any]);
    const rec = store.findById("sub-1") as any;
    rec.windowStartedAt = 1000;
    rec.weeklyWindowStartedAt = 500;
    rec.tokenUsageEvents = [{ at: 1000, totalTokens: 50, bucket: "anthropic-claude" }];
    rec.weeklyTokenUsageEvents = [{ at: 600, totalTokens: 30 }, { at: 1000, totalTokens: 50 }];

    const snaps = store.serializeSubscriptionWindows();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].id).toBe("sub-1");

    // 新进程:冷注册同一订阅后,从快照恢复。
    const store2 = makeStore([]);
    store2.loadSubscriptionRecords([{ id: "sub-1", status: "active", windowMs: 18000000 } as any]);
    store2.restoreSubscriptionWindow("sub-1", snaps[0].windowState);
    const rec2 = store2.findById("sub-1") as any;
    expect(rec2.windowStartedAt).toBe(1000);
    expect(rec2.weeklyWindowStartedAt).toBe(500);
    expect(rec2.tokenUsageEvents).toHaveLength(1);
    expect(rec2.weeklyTokenUsageEvents).toHaveLength(2);
  });

  it("无窗口活动的订阅 → serialize 不输出(省 DB 写)", () => {
    const store = makeStore([]);
    store.loadSubscriptionRecords([{ id: "sub-idle", status: "active" } as any]);
    expect(store.serializeSubscriptionWindows()).toEqual([]);
  });

  it("restore 容错:坏 JSON / 未知 id → 安静跳过,不抛", () => {
    const store = makeStore([]);
    store.loadSubscriptionRecords([{ id: "sub-1", status: "active" } as any]);
    expect(() => store.restoreSubscriptionWindow("sub-1", "{bad json")).not.toThrow();
    expect(() => store.restoreSubscriptionWindow("nope", JSON.stringify({ windowStartedAt: 1 }))).not.toThrow();
    const rec = store.findById("sub-1") as any;
    expect(Number(rec.windowStartedAt || 0)).toBe(0);
  });
});

describe("AccessKeyStore 运行时不落 access-keys.json(文件卡已退役,用量不再持久化到文件)", () => {
  it("订阅卡经 resolveFromRequest 激活 → 文件不被写脏(订阅走 windowState,不进文件)", async () => {
    const store = makeStore([]); // 文件初始 { keys: [], updatedAt: "" }
    store.setSessionResolver(cardIdSessionResolver);
    store.loadSubscriptionRecords([{
      id: "sub-1", key: "BK-1", customerId: "c1", status: "active",
      products: ["anthropic"], bucketLimits: { "anthropic-claude": 1_000_000 }, windowMs: 18_000_000,
    } as any]);

    const res = await store.resolveFromRequest(sessionReqFor("sub-1"), {}, {
      activate: true, enforceLimit: true, modelKey: "claude-opus-4", product: "anthropic",
    });
    expect(res.record?.id).toBe("sub-1"); // 命中订阅

    store.flush();
    const onDisk = JSON.parse(fs.readFileSync(lastStorePath, "utf8"));
    expect(onDisk.keys).toEqual([]);
    expect(onDisk.updatedAt).toBe(""); // 未发生过写盘
  });

  it("文件卡经 resolveFromRequest 激活 → 同样不再写盘(运行时持久化已移除)", async () => {
    const store = makeStore([{ id: "file-1", key: "FK-1", status: "active", windowMs: 18_000_000 }]);
    store.setSessionResolver(cardIdSessionResolver);

    await store.resolveFromRequest(sessionReqFor("file-1"), {}, { activate: true });

    store.flush();
    const onDisk = JSON.parse(fs.readFileSync(lastStorePath, "utf8"));
    // 运行时不再 writeCache → updatedAt 仍是初始空串(没发生过写盘)。
    expect(onDisk.updatedAt).toBe("");
  });
});
