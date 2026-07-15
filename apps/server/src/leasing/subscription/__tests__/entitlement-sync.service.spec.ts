/**
 * entitlement-sync.service.spec.ts — 去影子:订阅配置注册进 AccessKeyStore 的内存
 * subscriptionById,不再写 access-keys.json。
 *
 * 唯一真相源是订阅(数据库):
 *  - 运行时限额从内存 record(store.listSubscriptionRecords / findById)读,不读文件。
 *  - 号池 vs 绑定靠 config.line 显式区分,不靠 bindings 空不空推断。
 *  - 绑定线座位占用从 DB ACTIVE 订阅的 config count(weight 求和),不从文件数。
 *
 * Uses a real RosettaService (account pool over a tmp dataDir, for seat
 * selection), the real shared AccessKeyStore, and an in-memory Prisma stub
 * holding the ACTIVE subscriptions' configs.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EntitlementSyncService } from "../entitlement-sync.service";
import { RosettaService } from "../../rosetta/rosetta.service";
import { AccessKeyStore } from "../../token-server/access-key-store";
import { ACCOUNT_SHARE_CAPACITY } from "../../token-server/token-billing";
import { cardIdSessionResolver, sessionReqFor } from "../../token-server/__tests__/session-test-util";

const DAY_MS = 24 * 60 * 60 * 1000;
const CAP = ACCOUNT_SHARE_CAPACITY;

let tmpDir: string;
let accessKeysPath: string;

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Build a Subscription row whose config is a bind line by default (ultra antigravity). */
function makeSub(overrides: Partial<Record<string, any>> = {}) {
  const config = overrides.config ?? {
    line: "bind",
    products: ["antigravity"],
    levels: { antigravity: "ultra" },
    weight: overrides.weight ?? 2,
    deviceLimit: 3,
    windowMs: 18_000_000,
  };
  return {
    id: overrides.id ?? "sub-test-1",
    customerId: overrides.customerId ?? "cust-1",
    planId: overrides.planId === undefined ? "plan-1" : overrides.planId,
    status: overrides.status ?? "ACTIVE",
    startsAt: overrides.startsAt ?? new Date(),
    expiresAt: overrides.expiresAt === undefined ? new Date(Date.now() + 30 * DAY_MS) : overrides.expiresAt,
    config: JSON.stringify(config),
    backingKeyValue: overrides.backingKeyValue ?? "sub_" + "a".repeat(48),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;
}

/** Build a pool-line subscription config. */
function poolSub(overrides: Partial<Record<string, any>> = {}) {
  return makeSub({
    ...overrides,
    config: {
      line: "pool",
      products: ["antigravity"],
      bucketLimits: { "antigravity-gemini": 1_000_000 },
      weeklyTokenLimit: 5_000_000,
      deviceLimit: 3,
      windowMs: 18_000_000,
    },
  });
}

describe("EntitlementSyncService(去影子)", () => {
  let rosetta: RosettaService;
  let store: AccessKeyStore;
  let reloads: { tokenServer: any; remoteCodex: any; remoteAnthropic: any };
  let prismaStub: any;
  /** In-memory subscription store backing the DB seat-share count. */
  let subs: Map<string, any>;
  let planCatalog: any;
  let service: EntitlementSyncService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "entitlement-sync-"));
    accessKeysPath = path.join(tmpDir, "access-keys.json");
    writeJson(accessKeysPath, { keys: [], updatedAt: "" });
    // antigravity pool with one bindable ultra account; capacity is 4 (test env
    // BCAI_ACCOUNT_SHARE_CAPACITY=4).
    writeJson(path.join(tmpDir, "accounts.json"), {
      accounts: [
        { id: 7, email: "ultra@pool.test", refreshToken: "rt", enabled: true, projectId: "proj-7", planType: "ultra" },
      ],
    });

    rosetta = new RosettaService({ dataDir: tmpDir });
    store = new AccessKeyStore(accessKeysPath);
    store.setSessionResolver(cardIdSessionResolver);
    reloads = {
      tokenServer: { reloadAccessKeys: vi.fn(() => store.reload()) },
      remoteCodex: { reloadAccessKeys: vi.fn() },
      remoteAnthropic: { reloadAccessKeys: vi.fn() },
    };
    subs = new Map();
    prismaStub = {
      customer: { findUnique: vi.fn(async () => ({ email: "user@example.com" })) },
      subscription: {
        // The seat-share count reads ALL ACTIVE subs' configs from here.
        findMany: vi.fn(async () => [...subs.values()].filter((s) => s.status === "ACTIVE")),
        findUnique: vi.fn(async ({ where }: any) => subs.get(where.id) ?? null),
        update: vi.fn(async ({ where, data }: any) => {
          const row = subs.get(where.id);
          if (row) Object.assign(row, data);
          return row ?? { id: where.id, ...data };
        }),
      },
    };
    planCatalog = { getPublished: vi.fn(async () => ({ config: {} })) };
    service = new EntitlementSyncService(
      rosetta,
      store,
      reloads.tokenServer,
      reloads.remoteCodex,
      reloads.remoteAnthropic,
      prismaStub,
      planCatalog,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Register a sub into the in-memory DB stub before syncing. */
  function seed(sub: any) {
    subs.set(sub.id, sub);
    return sub;
  }

  // quotaSeatCapacity 只是已快照的最大可售份数，不得再次乘超卖系数。
  it("syncBind 把固定最大可售份数原样传给分配器", async () => {
    const spy = vi.spyOn(rosetta, "assignSeatForProductFromShares");
    await service.syncSubscription(seed(makeSub({ id: "sub-ceiling" })));
    expect(spy).toHaveBeenCalled();
    const opts = spy.mock.calls[0][6] as any;
    expect(opts?.oversellCeiling).toBe(CAP);
  });

  // ── Registration (no file) ────────────────────────────────────────────────

  it("新订阅 → 限额 record 进内存(listSubscriptionRecords 可见),access-keys.json 不被写", async () => {
    const sub = seed(makeSub());
    await service.syncSubscription(sub, { customerEmail: "user@example.com" });

    const records = store.listSubscriptionRecords();
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.id).toBe(sub.id);
    expect(record.status).toBe("active");
    expect(record.windowMs).toBe(18_000_000);
    expect(record.keyExpiresAt).toBe(sub.expiresAt.toISOString());
    expect(record.products).toEqual(["antigravity"]);

    // 文件没被写(仍是初始空)。
    expect(JSON.parse(fs.readFileSync(accessKeysPath, "utf8")).keys).toEqual([]);
    // findById 也能取到(运行时限额读它)。
    expect(store.findById(sub.id)?.id).toBe(sub.id);
  });

  // ── rebindProduct: 管理后台换绑/加绑 ──────────────────────────────────────

  it("rebindProduct 把某产品绑定切到指定号:写回 config.bindings + 内存 record 立即生效", async () => {
    seed(makeSub({ id: "sub-rebind" })); // antigravity bind, level ultra, weight 2
    const res = await service.rebindProduct("sub-rebind", "antigravity", 7);

    expect(res).toMatchObject({ ok: true, product: "antigravity", accountId: 7 });
    // 写回 config.bindings + 镜像 legacy bindings 列。
    const row = subs.get("sub-rebind");
    expect(JSON.parse(row.config).bindings).toEqual({ antigravity: 7 });
    expect(JSON.parse(row.bindings)).toEqual({ antigravity: 7 });
    // 内存 record 立即按新绑定路由。
    expect(store.findById("sub-rebind")?.bindings).toEqual({ antigravity: 7 });
    expect(reloads.tokenServer.reloadAccessKeys).toHaveBeenCalled();
  });

  it("rebindProduct waits for every pool reload/checkpoint before acknowledging", async () => {
    seed(makeSub({ id: "sub-rebind-await" }));
    const releases: Array<() => void> = [];
    for (const target of Object.values(reloads) as any[]) {
      target.reloadAccessKeys.mockImplementation(() => new Promise<void>((resolve) => releases.push(resolve)));
    }
    let settled = false;
    const result = service.rebindProduct("sub-rebind-await", "antigravity", 7)
      .finally(() => { settled = true; });

    await vi.waitFor(() => expect(releases).toHaveLength(3));
    expect(settled).toBe(false);
    releases.splice(0).forEach((release) => release());

    await expect(result).resolves.toMatchObject({ ok: true });
  });

  it("rebindProduct 拒绝:目标号不存在", async () => {
    seed(makeSub({ id: "sub-rebind-2" }));
    const res = await service.rebindProduct("sub-rebind-2", "antigravity", 999);
    expect(res).toMatchObject({ ok: false });
    expect((res as any).error).toContain("不存在");
  });

  it("rebindProduct 到达最大可售份数后拒绝，显式 force 才可突破", async () => {
    // subA weight 4 占满 account 7(容量 4)。
    const subA = seed(makeSub({ id: "sub-fill", weight: 4, backingKeyValue: "sub_" + "1".repeat(48) }));
    await service.syncSubscription(subA);
    // subB(尚未绑)换绑到已达上限的号 7 → 默认拒绝。
    seed(makeSub({ id: "sub-over", weight: 2, config: { line: "bind", products: ["antigravity"], levels: { antigravity: "ultra" }, weight: 2, deviceLimit: 1, windowMs: 18_000_000 } }));
    const rejected = await service.rebindProduct("sub-over", "antigravity", 7);
    expect(rejected).toMatchObject({ ok: false });
    const res = await service.rebindProduct("sub-over", "antigravity", 7, { force: true });
    expect(res).toMatchObject({ ok: true, product: "antigravity", accountId: 7 });
    expect(JSON.parse(subs.get("sub-over").config).bindings).toEqual({ antigravity: 7 });
  });

  it("rebindProduct 拒绝:订阅未开通该产品", async () => {
    seed(makeSub({ id: "sub-rebind-3" })); // 只开通 antigravity
    const res = await service.rebindProduct("sub-rebind-3", "codex", 7);
    expect(res).toMatchObject({ ok: false });
    expect((res as any).error).toContain("未开通");
  });

  // ── bind line: seat assignment, requiresBinding ───────────────────────────

  it("绑定线 → 分配座位、bindings 写回 config、requiresBinding=true", async () => {
    const sub = seed(makeSub());
    await service.syncSubscription(sub);

    const record = store.findById(sub.id)!;
    expect(record.bindings).toEqual({ antigravity: 7 });
    expect(record.weight).toBe(2);
    expect(record.requiresBinding).toBe(true);

    // bindings 写回 Subscription.config(单一真相源)。
    expect(prismaStub.subscription.update).toHaveBeenCalled();
    const persisted = JSON.parse(subs.get(sub.id).config);
    expect(persisted.line).toBe("bind");
    expect(persisted.bindings).toEqual({ antigravity: 7 });
  });

  it("绑定线达到固定最大可售份数后，新订阅保持 UNBOUND", async () => {
    // subA weight 4 占满 account 7(容量 4)。
    const subA = seed(makeSub({ id: "sub-full", weight: 4, backingKeyValue: "sub_" + "1".repeat(48) }));
    await service.syncSubscription(subA);
    expect(JSON.parse(subs.get("sub-full").config).bindings).toEqual({ antigravity: 7 });

    // subB 需要座位、DB 已达固定上限 → 保持 UNBOUND。
    const subB = seed(makeSub({ id: "sub-starved", weight: 1, backingKeyValue: "sub_" + "2".repeat(48) }));
    await service.syncSubscription(subB);

    const record = store.findById("sub-starved")!;
    expect(record.bindings).toEqual({});
    expect(record.requiresBinding).toBe(true);
    expect(JSON.parse(subs.get("sub-starved").config).bindings).toEqual({});
  });

  it("绑定线等级真·无可绑号(等级不存在)→ 仍 UNBOUND(超卖只在「有可绑号」时兜底)", async () => {
    // 与上一例对照：等级无号同样会保持 UNBOUND。
    const sub = seed(makeSub({ id: "sub-no-acct", config: { line: "bind", products: ["antigravity"], levels: { antigravity: "premium" }, weight: 1, deviceLimit: 1, windowMs: 18_000_000 } }));
    await service.syncSubscription(sub);
    const record = store.findById("sub-no-acct")!;
    expect(record.bindings).toEqual({});
    expect(record.requiresBinding).toBe(true);
  });

  it("绑定线按 config.quotaSeatCapacity 快照判断容量,允许同号售出超过默认容量", async () => {
    const config = {
      line: "bind",
      products: ["antigravity"],
      levels: { antigravity: "ultra" },
      weight: 4,
      quotaSeatCapacity: 10,
      deviceLimit: 1,
      windowMs: 18_000_000,
    };
    const subA = seed(makeSub({ id: "sub-sold-a", config, backingKeyValue: "sub_" + "1".repeat(48) }));
    await service.syncSubscription(subA);
    const subB = seed(makeSub({ id: "sub-sold-b", config, backingKeyValue: "sub_" + "2".repeat(48) }));
    await service.syncSubscription(subB);

    expect(store.findById("sub-sold-a")!.bindings).toEqual({ antigravity: 7 });
    expect(store.findById("sub-sold-b")!.bindings).toEqual({ antigravity: 7 });
    expect(JSON.parse(subs.get("sub-sold-b").config).bindings).toEqual({ antigravity: 7 });
  });

  it("绑定线等级无空闲号(等级不存在)→ 该产品 UNBOUND、sync 仍成功", async () => {
    const sub = seed(makeSub({ config: { line: "bind", products: ["antigravity"], levels: { antigravity: "premium" }, weight: 1, deviceLimit: 1, windowMs: 18_000_000 } }));
    await expect(service.syncSubscription(sub)).resolves.toBeUndefined();

    const record = store.findById(sub.id)!;
    expect(record.bindings).toEqual({});
    expect(record.status).toBe("active");
    expect(record.requiresBinding).toBe(true);
  });

  // ── pool line: no seat ────────────────────────────────────────────────────

  it("号池线 → 跳过座位分配、bindings 空、不 requiresBinding,record 含用量上限", async () => {
    const sub = seed(poolSub());
    await service.syncSubscription(sub);

    const record = store.findById(sub.id)!;
    expect(record.bindings ?? {}).toEqual({});
    expect(record.requiresBinding).toBeFalsy();
    expect(record.bucketLimits).toEqual({ "antigravity-gemini": 1_000_000 });
    expect(record.weeklyTokenLimit).toBe(5_000_000);
    // 号池不写座位 → 不动 Subscription.config。
    expect(prismaStub.subscription.update).not.toHaveBeenCalled();
  });

  it("号池线即便误带 bindings,也不占座位(只看 line)", async () => {
    const sub = seed(makeSub({
      config: { line: "pool", products: ["antigravity"], bindings: { antigravity: 7 }, bucketLimits: {}, weeklyTokenLimit: 0, deviceLimit: 1, windowMs: 18_000_000 },
    }));
    await service.syncSubscription(sub);
    // 容量未被号池占用 → 绑定线仍能拿到 account 7 的全部 4 份。
    const bindSub = seed(makeSub({ id: "sub-bind", weight: 4, backingKeyValue: "sub_" + "9".repeat(48) }));
    await service.syncSubscription(bindSub);
    expect(store.findById("sub-bind")!.bindings).toEqual({ antigravity: 7 });
  });

  // ── resync (extend) preserves usage ───────────────────────────────────────

  it("resync(续期)→ 刷新过期时间,用量计数与内存窗口不动", async () => {
    const sub = seed(makeSub());
    await service.syncSubscription(sub);

    // 通过内存 record 记真实用量(进入限流窗口事件;累计计数已下线)。
    expect(store.recordUsage(sub.id, 200, { totalTokens: 500 }, "gemini-2.5-pro", "r1", "antigravity")).toBe(true);
    expect(store.findById(sub.id)!.tokenUsageEvents?.length).toBe(1);

    const newExpiry = new Date(Date.now() + 60 * DAY_MS);
    await service.syncSubscription(makeSub({ id: sub.id, expiresAt: newExpiry, config: JSON.parse(subs.get(sub.id).config) }));

    const after = store.findById(sub.id)!;
    expect(after.keyExpiresAt).toBe(newExpiry.toISOString());
    // resync 不动限流窗口:那条用量事件还在。
    expect(after.tokenUsageEvents?.length).toBe(1);
  });

  it("人工清零持久化失败时回滚内存 USD 用量", async () => {
    store.loadSubscriptionRecords([{
      id: "sub-usd-reset",
      key: "sub-usd-reset-key",
      status: "active",
      products: ["codex"],
      bindings: { codex: 9 },
      quotaAlgorithm: "usd",
      usdQuotaByProduct: { codex: { fiveHour: 10, weekly: 100 } },
    }] as any);
    const record = store.findById("sub-usd-reset")!;
    record.usdUsageByProduct = {
      codex: { used5h: 4.25, usedWeekly: 18, windowStartedAt5h: Date.now(), windowStartedAtWeekly: Date.now() },
    };
    prismaStub.subscription.update.mockRejectedValueOnce(new Error("database busy"));

    await expect(service.resetSubscriptionUsdQuotaUsage("sub-usd-reset", "codex", "fiveHour"))
      .rejects.toThrow("database busy");
    expect(store.publicStatus(record, 0, "codex").usdQuotaByProduct.codex.fiveHour.used).toBe(4.25);
    expect(store.publicStatus(record, 0, "codex").usdQuotaByProduct.codex.weekly.used).toBe(18);
  });

  it("resync 复用 config 里已写的 bindings,不再分配座位(不重复写 DB)", async () => {
    const sub = seed(makeSub());
    await service.syncSubscription(sub);
    prismaStub.subscription.update.mockClear();

    // config 已带 bindings(DB 行如此),resync 直接复用。
    await service.syncSubscription(makeSub({ id: sub.id, config: JSON.parse(subs.get(sub.id).config) }));

    expect(store.findById(sub.id)!.bindings).toEqual({ antigravity: 7 });
    expect(prismaStub.subscription.update).not.toHaveBeenCalled();
  });

  it("null expiresAt → keyExpiresAt 不设", async () => {
    const sub = seed(poolSub({ planId: null, expiresAt: null }));
    await service.syncSubscription(sub);
    expect(store.findById(sub.id)!.keyExpiresAt).toBeUndefined();
  });

  // ── expire ────────────────────────────────────────────────────────────────

  it("expireShadowRecord → record.status=expired、用量保留,过期 record 不再 resolve", async () => {
    const sub = seed(makeSub());
    await service.syncSubscription(sub);
    store.recordUsage(sub.id, 200, { totalTokens: 500 }, "gemini-2.5-pro", "r1", "antigravity");
    const eventsBefore = store.findById(sub.id)!.tokenUsageEvents?.length ?? 0;

    service.expireShadowRecord(sub.id);

    const record = store.findById(sub.id)!;
    expect(record.status).toBe("expired");
    expect(record.tokenUsageEvents?.length ?? 0).toBe(eventsBefore); // 限流窗口用量保留

    const resolved = await store.resolveFromRequest(sessionReqFor(sub.id), {});
    expect(resolved.record).toBeNull();
  });

  it("expireShadowRecord 释放座位:过期后绑定线可复用该号", async () => {
    const subA = seed(makeSub({ id: "sub-full", weight: 4, backingKeyValue: "sub_" + "1".repeat(48) }));
    await service.syncSubscription(subA);
    expect(store.findById("sub-full")!.bindings).toEqual({ antigravity: 7 });

    // 标记 EXPIRED 后从 DB count 释放(findMany 只数 ACTIVE)。
    subs.get("sub-full").status = "EXPIRED";
    service.expireShadowRecord("sub-full");

    const subB = seed(makeSub({ id: "sub-next", weight: 4, backingKeyValue: "sub_" + "2".repeat(48) }));
    await service.syncSubscription(subB);
    expect(store.findById("sub-next")!.bindings).toEqual({ antigravity: 7 });
  });

  // ── concurrency: serialized read-assign-write ────────────
  it("两个并发绑定抢同一号时最多一个越过剩余份数", async () => {
    const subA = seed(makeSub({ id: "sub-race-a", weight: 3, backingKeyValue: "sub_" + "a".repeat(48) }));
    const subB = seed(makeSub({ id: "sub-race-b", weight: 3, backingKeyValue: "sub_" + "b".repeat(48) }));

    await Promise.all([
      service.syncSubscription(subA, { customerEmail: "a@example.com" }),
      service.syncSubscription(subB, { customerEmail: "b@example.com" }),
    ]);

    const boundA = JSON.parse(subs.get("sub-race-a").config).bindings.antigravity === 7;
    const boundB = JSON.parse(subs.get("sub-race-b").config).bindings.antigravity === 7;
    // 唯一可绑号 7；固定上限 4 装不下两个 weight-3，最多一个成功。
    expect(Number(boundA) + Number(boundB)).toBe(1);
  });
});
