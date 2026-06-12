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
