/**
 * subscription.service.spec.ts — subscription lifecycle rules against the real
 * Prisma test db, with a REAL EntitlementSyncService writing shadow records
 * into a tmp access-keys.json (integration through the single writer).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SubscriptionService } from "../subscription.service";
import { EntitlementSyncService } from "../entitlement-sync.service";
import { PlanCatalogService } from "../../plan-catalog/plan-catalog.service";
import { RosettaService } from "../../rosetta/rosetta.service";
import { AccessKeyStore } from "../../token-server/access-key-store";
import {
  cleanCustomerTables,
  createTestCustomer,
  disconnectCustomerDb,
  ensureCustomerSchema,
  getCustomerPrisma,
} from "../../../shared/__tests__/customer-test-db";

const prisma = getCustomerPrisma();
const DAY_MS = 24 * 60 * 60 * 1000;

let tmpDir: string;
let accessKeysPath: string;
let store: AccessKeyStore;
let service: SubscriptionService;

/**
 * 去影子:运行时限额从内存订阅 record 读,不读 access-keys.json。早先用 readKeys(文件),
 * 现改读 store.listSubscriptionRecords()(内存),口径与生产一致。
 */
function readKeys(): any[] {
  return store.listSubscriptionRecords();
}

async function createPlan(overrides: Partial<Record<string, any>> = {}) {
  return prisma.plan.create({
    data: {
      name: overrides.name ?? "Pro 月卡",
      priceCents: overrides.priceCents ?? 9900,
      durationDays: overrides.durationDays ?? 30,
      productEntitlements: overrides.productEntitlements ?? JSON.stringify(["antigravity"]),
      bucketLimits: overrides.bucketLimits ?? JSON.stringify({ "antigravity-gemini": 1_000_000 }),
      levels: overrides.levels ?? JSON.stringify({ antigravity: "ultra" }),
      weight: overrides.weight ?? 1,
      deviceLimit: overrides.deviceLimit ?? 3,
      weeklyTokenLimit: overrides.weeklyTokenLimit ?? 5_000_000,
      windowMs: overrides.windowMs ?? 18_000_000,
    },
  });
}

beforeAll(async () => {
  await ensureCustomerSchema();
});

beforeEach(async () => {
  await cleanCustomerTables();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subscription-svc-"));
  accessKeysPath = path.join(tmpDir, "access-keys.json");
  fs.writeFileSync(accessKeysPath, JSON.stringify({ keys: [], updatedAt: "" }));
  fs.writeFileSync(path.join(tmpDir, "accounts.json"), JSON.stringify({
    accounts: [
      { id: 1, email: "ultra-1@pool.test", refreshToken: "rt", enabled: true, projectId: "p1", planType: "ultra" },
      { id: 2, email: "ultra-2@pool.test", refreshToken: "rt", enabled: true, projectId: "p2", planType: "ultra" },
    ],
  }));

  const rosetta = new RosettaService({ dataDir: tmpDir });
  store = new AccessKeyStore(accessKeysPath);
  const sync = new EntitlementSyncService(
    rosetta,
    store,
    { reloadAccessKeys: vi.fn(() => store.reload()) } as any,
    { reloadAccessKeys: vi.fn() } as any,
    { reloadAccessKeys: vi.fn() } as any,
    prisma as any,
  );
  const planCatalog = new PlanCatalogService(prisma as any);
  service = new SubscriptionService(prisma as any, sync, planCatalog);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  await cleanCustomerTables();
  await disconnectCustomerDb();
});

describe("SubscriptionService.createFromPlan / activateOrExtend", () => {
  it("creates an ACTIVE sub with plan snapshots, sub_+48hex backing key, and a shadow record", async () => {
    const customer = await createTestCustomer();
    const plan = await createPlan();

    const sub = await service.activateOrExtend(customer.id, plan.id);

    expect(sub.status).toBe("ACTIVE");
    expect(sub.planId).toBe(plan.id);
    expect(sub.customerId).toBe(customer.id);
    expect(sub.backingKeyValue).toMatch(/^sub_[0-9a-f]{48}$/);
    expect(sub.productEntitlements).toBe(plan.productEntitlements);
    expect(sub.bucketLimits).toBe(plan.bucketLimits);
    expect(sub.weight).toBe(plan.weight);
    expect(sub.deviceLimit).toBe(plan.deviceLimit);
    expect(sub.weeklyTokenLimit).toBe(plan.weeklyTokenLimit);
    expect(sub.windowMs).toBe(plan.windowMs);
    const expectedExpiry = Date.now() + 30 * DAY_MS;
    expect(Math.abs(sub.expiresAt!.getTime() - expectedExpiry)).toBeLessThan(60_000);
    // Auto-assigned seat persisted onto the row snapshot.
    expect(JSON.parse(sub.bindings!)).toEqual({ antigravity: expect.any(Number) });
    // 去影子:下单激活时把限额配置快照进 Subscription.config(单一真相源,含 line)。
    // 该 plan(有 levels、bindings 已分配真实号)→ 绑定线。
    const config = JSON.parse(sub.config!);
    expect(config).toMatchObject({
      line: "bind",
      products: ["antigravity"],
      levels: { antigravity: "ultra" },
      weight: plan.weight,
      deviceLimit: plan.deviceLimit,
      windowMs: plan.windowMs,
    });
    expect(config.bindings).toEqual({ antigravity: expect.any(Number) });

    // 去影子:运行时 record 在内存,以 id(=订阅 id,会话 JWT 解析到它)为键,不再带卡 key/name。
    const record = readKeys().find((k) => k.id === sub.id);
    expect(record).toBeTruthy();
    expect(record.status).toBe("active");
    expect(record.keyExpiresAt).toBe(sub.expiresAt!.toISOString());
    expect(record.bindings).toEqual({ antigravity: expect.any(Number) });
  });

  it("same plan again → EXTENDS the same sub (expiry += durationDays), no second sub or record", async () => {
    const customer = await createTestCustomer();
    const plan = await createPlan({ durationDays: 30 });

    const first = await service.activateOrExtend(customer.id, plan.id);
    const second = await service.activateOrExtend(customer.id, plan.id);

    expect(second.id).toBe(first.id);
    expect(second.expiresAt!.getTime() - first.expiresAt!.getTime()).toBe(30 * DAY_MS);
    expect(await prisma.subscription.count({ where: { customerId: customer.id } })).toBe(1);
    expect(readKeys()).toHaveLength(1);
    expect(readKeys()[0].keyExpiresAt).toBe(second.expiresAt!.toISOString());
  });

  it("a different plan with INTERSECTING products cancels the old sub and expires its record", async () => {
    const customer = await createTestCustomer();
    const planA = await createPlan({ name: "A", productEntitlements: JSON.stringify(["antigravity", "codex"]) });
    const planB = await createPlan({ name: "B", productEntitlements: JSON.stringify(["codex"]) });

    const subA = await service.activateOrExtend(customer.id, planA.id);
    const subB = await service.activateOrExtend(customer.id, planB.id);

    const reloadedA = await prisma.subscription.findUnique({ where: { id: subA.id } });
    expect(reloadedA!.status).toBe("CANCELLED");
    expect(subB.status).toBe("ACTIVE");
    expect(subB.id).not.toBe(subA.id);

    const recordA = readKeys().find((k) => k.id === subA.id);
    const recordB = readKeys().find((k) => k.id === subB.id);
    expect(recordA.status).toBe("expired");
    expect(recordB.status).toBe("active");
  });

  it("a different plan with DISJOINT products leaves the old sub active (coexist)", async () => {
    const customer = await createTestCustomer();
    const planA = await createPlan({ name: "A", productEntitlements: JSON.stringify(["antigravity"]) });
    const planB = await createPlan({
      name: "B",
      productEntitlements: JSON.stringify(["codex"]),
      levels: JSON.stringify({ codex: "pro" }),
    });

    const subA = await service.activateOrExtend(customer.id, planA.id);
    const subB = await service.activateOrExtend(customer.id, planB.id);

    expect((await prisma.subscription.findUnique({ where: { id: subA.id } }))!.status).toBe("ACTIVE");
    expect(subB.status).toBe("ACTIVE");
    expect(readKeys().filter((k) => k.status === "active")).toHaveLength(2);
  });

  it("migrated card subs (planId null) are NEVER auto-cancelled by purchases", async () => {
    const customer = await createTestCustomer();
    const migrated = await prisma.subscription.create({
      data: {
        id: "card-mig-1",
        customerId: customer.id,
        planId: null,
        status: "ACTIVE",
        productEntitlements: JSON.stringify(["antigravity", "codex", "anthropic"]),
        backingKeyValue: "sub_" + "b".repeat(48),
        expiresAt: null,
      },
    });
    const plan = await createPlan({ productEntitlements: JSON.stringify(["antigravity"]) });

    const sub = await service.activateOrExtend(customer.id, plan.id);

    expect(sub.status).toBe("ACTIVE");
    const migratedAfter = await prisma.subscription.findUnique({ where: { id: migrated.id } });
    expect(migratedAfter!.status).toBe("ACTIVE");
  });

  it("expireSubscription / cancelSubscription set the status and expire the shadow record", async () => {
    const customer = await createTestCustomer();
    const plan = await createPlan();
    const sub = await service.activateOrExtend(customer.id, plan.id);

    await service.expireSubscription(sub.id);
    expect((await prisma.subscription.findUnique({ where: { id: sub.id } }))!.status).toBe("EXPIRED");
    expect(readKeys().find((k) => k.id === sub.id).status).toBe("expired");

    const sub2 = await service.createFromPlan(customer.id, plan);
    await service.cancelSubscription(sub2.id);
    expect((await prisma.subscription.findUnique({ where: { id: sub2.id } }))!.status).toBe("CANCELLED");
    expect(readKeys().find((k) => k.id === sub2.id).status).toBe("expired");
  });

  it("activateOrExtend with an unknown plan throws NotFound", async () => {
    const customer = await createTestCustomer();
    await expect(service.activateOrExtend(customer.id, "no-such-plan")).rejects.toThrow(/not found/i);
  });

  it("activateOrExtend with an orderId persists activatedFromOrderId (create AND extend)", async () => {
    const customer = await createTestCustomer();
    const plan = await createPlan();

    const created = await service.activateOrExtend(customer.id, plan.id, { orderId: "order-1" });
    expect(created.activatedFromOrderId).toBe("order-1");

    // Same plan again with a NEW order → same sub, link moves to the latest order.
    const extended = await service.activateOrExtend(customer.id, plan.id, { orderId: "order-2" });
    expect(extended.id).toBe(created.id);
    expect(extended.activatedFromOrderId).toBe("order-2");

    // No orderId (e.g. an admin grant) → existing link is left alone.
    const extendedAgain = await service.activateOrExtend(customer.id, plan.id);
    expect(extendedAgain.activatedFromOrderId).toBe("order-2");
  });

  it("activateOrExtend without an orderId leaves activatedFromOrderId null on create", async () => {
    const customer = await createTestCustomer();
    const plan = await createPlan();

    const sub = await service.activateOrExtend(customer.id, plan.id);

    expect(sub.activatedFromOrderId).toBeNull();
  });
});

describe("SubscriptionService.createFromCatalog / activateForOrder (catalog 下单激活)", () => {
  // catalog 路径:订单已带 computePurchase 生成的 config + catalogVersion,激活把它原样写进
  // Subscription.config(单一真相源,含显式 line),expiresAt 用该版 catalog 的 durationDays。
  async function publishCatalog(durationDays = 30, version = 1) {
    await prisma.planCatalog.deleteMany();
    return prisma.planCatalog.create({
      data: {
        version,
        status: "PUBLISHED",
        config: JSON.stringify({ durationDays, windowMs: 18_000_000 }),
        publishedAt: new Date(),
      },
    });
  }

  afterEach(async () => {
    await prisma.planCatalog.deleteMany();
  });

  it("号池线 catalog 订单 → ACTIVE 订阅,config 原样、catalogVersion 记录、expiresAt = now + 目录 durationDays,有 record", async () => {
    const customer = await createTestCustomer();
    await publishCatalog(30, 1);
    const poolConfig = {
      line: "pool",
      products: ["anthropic"],
      bucketLimits: { "anthropic-claude": 150000 },
      weeklyTokenLimit: 750000,
      deviceLimit: 2,
      windowMs: 18_000_000,
    };
    const order = {
      id: "catalog-order-1",
      customerId: customer.id,
      planId: null,
      config: JSON.stringify(poolConfig),
      catalogVersion: 1,
    };

    const sub = await service.activateForOrder(order);

    expect(sub.status).toBe("ACTIVE");
    expect(sub.planId).toBeNull();
    expect(sub.catalogVersion).toBe(1);
    expect(sub.activatedFromOrderId).toBe("catalog-order-1");
    expect(sub.backingKeyValue).toMatch(/^sub_[0-9a-f]{48}$/);
    // config 原样落库(号池线:无座位分配,bindings 不写)。
    expect(JSON.parse(sub.config!)).toEqual(poolConfig);
    const expectedExpiry = Date.now() + 30 * DAY_MS;
    expect(Math.abs(sub.expiresAt!.getTime() - expectedExpiry)).toBeLessThan(60_000);
    // 号池线:运行时 record 在内存,按用量限额(不要求 binding)。
    const record = readKeys().find((k) => k.id === sub.id);
    expect(record).toBeTruthy();
    expect(record.status).toBe("active");
    expect(record.bucketLimits).toEqual(poolConfig.bucketLimits);
  });

  it("绑定线 catalog 订单 → sync 分配座位写回 config.bindings,record 带 bindings", async () => {
    const customer = await createTestCustomer();
    await publishCatalog(30, 2);
    const bindConfig = {
      line: "bind",
      products: ["antigravity"],
      levels: { antigravity: "ultra" },
      bindings: {},
      weight: 2,
      deviceLimit: 1,
      windowMs: 18_000_000,
    };
    const order = {
      id: "catalog-order-bind",
      customerId: customer.id,
      planId: null,
      config: JSON.stringify(bindConfig),
      catalogVersion: 2,
    };

    const sub = await service.activateForOrder(order);

    expect(sub.status).toBe("ACTIVE");
    const config = JSON.parse(sub.config!);
    expect(config.line).toBe("bind");
    // 绑定线:sync 在写锁内分配真实号写回 config.bindings(单一真相源)。
    expect(config.bindings).toEqual({ antigravity: expect.any(Number) });
    const record = readKeys().find((k) => k.id === sub.id);
    expect(record.bindings).toEqual({ antigravity: expect.any(Number) });
  });

  it("同配置再买(号池)→ 延长同一订阅 expiresAt(+目录 durationDays),不新建、不多 record(spec §8)", async () => {
    const customer = await createTestCustomer();
    await publishCatalog(30, 1);
    const poolConfig = {
      line: "pool",
      products: ["anthropic"],
      bucketLimits: { "anthropic-claude": 150000 },
      weeklyTokenLimit: 750000,
      deviceLimit: 2,
      windowMs: 18_000_000,
    };
    const mkOrder = (id: string) => ({
      id,
      customerId: customer.id,
      planId: null,
      config: JSON.stringify(poolConfig),
      catalogVersion: 1,
    });

    const first = await service.activateForOrder(mkOrder("catalog-order-1"));
    // 第二单 config 等价(键序不同也算同):延长复用。
    const second = await service.activateForOrder(
      mkOrder("catalog-order-2"),
    );

    expect(second.id).toBe(first.id);
    expect(second.expiresAt!.getTime() - first.expiresAt!.getTime()).toBe(30 * DAY_MS);
    expect(await prisma.subscription.count({ where: { customerId: customer.id } })).toBe(1);
    expect(readKeys()).toHaveLength(1);
    expect(readKeys()[0].keyExpiresAt).toBe(second.expiresAt!.toISOString());
    // 续费把订单链移到最新一单(对账/退款)。
    expect(second.activatedFromOrderId).toBe("catalog-order-2");
  });

  it("过期订阅不参与续费去重:同配置但已 EXPIRED → 新建,不延长", async () => {
    const customer = await createTestCustomer();
    await publishCatalog(30, 1);
    const poolConfig = {
      line: "pool",
      products: ["codex"],
      bucketLimits: { "codex-codex": 40000 },
      weeklyTokenLimit: 200000,
      deviceLimit: 1,
      windowMs: 18_000_000,
    };
    const first = await service.activateForOrder({
      id: "catalog-order-old",
      customerId: customer.id,
      planId: null,
      config: JSON.stringify(poolConfig),
      catalogVersion: 1,
    });
    await service.expireSubscription(first.id);

    const second = await service.activateForOrder({
      id: "catalog-order-new",
      customerId: customer.id,
      planId: null,
      config: JSON.stringify(poolConfig),
      catalogVersion: 1,
    });

    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("ACTIVE");
    expect(await prisma.subscription.count({ where: { customerId: customer.id } })).toBe(2);
  });

  it("不同配置再买 → 新建并存(不同 deviceLimit 不算同配置)", async () => {
    const customer = await createTestCustomer();
    await publishCatalog(30, 1);
    const base = {
      line: "pool",
      products: ["anthropic"],
      bucketLimits: { "anthropic-claude": 150000 },
      weeklyTokenLimit: 750000,
      windowMs: 18_000_000,
    };
    const first = await service.activateForOrder({
      id: "catalog-order-a",
      customerId: customer.id,
      planId: null,
      config: JSON.stringify({ ...base, deviceLimit: 1 }),
      catalogVersion: 1,
    });
    const second = await service.activateForOrder({
      id: "catalog-order-b",
      customerId: customer.id,
      planId: null,
      config: JSON.stringify({ ...base, deviceLimit: 3 }),
      catalogVersion: 1,
    });

    expect(second.id).not.toBe(first.id);
    expect(await prisma.subscription.count({ where: { customerId: customer.id, status: "ACTIVE" } })).toBe(2);
    expect(readKeys().filter((k) => k.status === "active")).toHaveLength(2);
  });

  it("同配置再买(绑定)→ 延长复用,座位不重分配(仍占同号同份额,不新增占用)", async () => {
    const customer = await createTestCustomer();
    await publishCatalog(30, 2);
    const bindConfig = {
      line: "bind",
      products: ["antigravity"],
      levels: { antigravity: "ultra" },
      bindings: {},
      weight: 2,
      deviceLimit: 1,
      windowMs: 18_000_000,
    };
    const mkOrder = (id: string) => ({
      id,
      customerId: customer.id,
      planId: null,
      config: JSON.stringify(bindConfig),
      catalogVersion: 2,
    });

    const first = await service.activateForOrder(mkOrder("catalog-bind-1"));
    const firstAccountId = JSON.parse(first.config!).bindings.antigravity;
    const second = await service.activateForOrder(mkOrder("catalog-bind-2"));

    expect(second.id).toBe(first.id);
    expect(second.expiresAt!.getTime() - first.expiresAt!.getTime()).toBe(30 * DAY_MS);
    expect(await prisma.subscription.count({ where: { customerId: customer.id } })).toBe(1);
    // 续期复用同号(座位不重分配),占用份额不变(同号同 weight)。
    expect(JSON.parse(second.config!).bindings.antigravity).toBe(firstAccountId);
  });

  it("activateForOrder 路由:plan 订单(planId 非空)走 createFromPlan(catalogVersion 留 null)", async () => {
    const customer = await createTestCustomer();
    const plan = await createPlan();

    const sub = await service.activateForOrder({
      id: "plan-order-1",
      customerId: customer.id,
      planId: plan.id,
      config: null,
      catalogVersion: null,
    });

    expect(sub.planId).toBe(plan.id);
    expect(sub.catalogVersion).toBeNull();
    expect(sub.activatedFromOrderId).toBe("plan-order-1");
  });

  it("catalog 订单缺 config → 报错(契约:catalog 订单必带 computePurchase 的 config)", async () => {
    const customer = await createTestCustomer();
    await expect(
      service.activateForOrder({
        id: "bad-order",
        customerId: customer.id,
        planId: null,
        config: null,
        catalogVersion: 1,
      }),
    ).rejects.toThrow();
  });
});
