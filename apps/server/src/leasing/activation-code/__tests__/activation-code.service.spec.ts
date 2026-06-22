/**
 * activation-code.service.spec.ts — 激活码 generate / activate 编排逻辑。
 *
 * 单元测试:mock Prisma + BillingService + SubscriptionService + PlanCatalogService
 * (与 billing.service.catalog.spec 同口径,无真实 DB)。验证:
 *  - generate:对当前 PUBLISHED 目录校验 selection,createMany 生成 N 条 UNUSED 码,不碰账号池。
 *  - activate:UNUSED → 造 ACTIVATION_CODE 订单 → forceNew 激活订阅 → 标记 ACTIVATED;
 *    座位不足/目录非法 → 码保持 UNUSED 可重试;已停用/已被他人用/不存在 → 各自报错;本人重复 → 幂等。
 */
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";

import { ActivationCodeService } from "../activation-code.service";

const POOL_SELECTION = { line: "pool", products: ["anthropic"], usageTier: "large", deviceLimit: 2 };

function makeCatalog(published: any = { version: 2, config: { durationDays: 30, windowMs: 18_000_000, usageTiers: { large: { bucketLimits: {}, weeklyTokenLimit: 0 } }, pricing: { pool: { product: { anthropic: 6900 }, usage: { large: 0 }, devicePerExtra: 0 }, bind: { levelPrice: {}, share: {}, devicePerExtra: 0 } }, products: ["anthropic"], levels: { anthropic: ["pro"] } } }) {
  return { getPublished: vi.fn().mockResolvedValue(published) } as any;
}

function makePrisma(overrides: Record<string, any> = {}) {
  return {
    activationCode: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    subscription: {
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(),
    },
    customer: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  } as any;
}

const fixedSub = {
  id: "sub-new-1",
  expiresAt: new Date("2026-07-22T00:00:00.000Z"),
  productEntitlements: JSON.stringify(["anthropic"]),
  deviceLimit: 2,
};

function makeBilling(order: any = { id: "code-order-1" }) {
  return { createActivationCodeOrder: vi.fn().mockResolvedValue(order) } as any;
}

function makeSubscriptions(sub: any = fixedSub) {
  return { activateForOrder: vi.fn().mockResolvedValue(sub) } as any;
}

describe("ActivationCodeService.generate", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: ActivationCodeService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new ActivationCodeService(prisma, makeBilling(), makeSubscriptions(), makeCatalog());
  });
  afterEach(() => vi.restoreAllMocks());

  it("生成 N 条 UNUSED 码,带 selection 快照,不碰账号池(不预检座位)", async () => {
    const result = await service.generate({ selection: POOL_SELECTION as any, count: 3, name: "618活动" });

    expect(prisma.activationCode.createMany).toHaveBeenCalledOnce();
    const rows = prisma.activationCode.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(typeof row.code).toBe("string");
      expect(row.code.length).toBeGreaterThan(8);
      expect(JSON.parse(row.selection)).toEqual(POOL_SELECTION);
      expect(row.name).toBe("618活动");
      // status 不显式写 → 依赖 schema 默认 UNUSED
      expect(row.status).toBeUndefined();
    }
    // 码互不相同
    const codes = rows.map((r: any) => r.code);
    expect(new Set(codes).size).toBe(3);
    // 同批次共享 batchId
    expect(new Set(rows.map((r: any) => r.batchId)).size).toBe(1);
    expect(result.codes).toEqual(codes);
  });

  it("count 夹逼到 [1,200]", async () => {
    await service.generate({ selection: POOL_SELECTION as any, count: 0 });
    expect(prisma.activationCode.createMany.mock.calls[0][0].data).toHaveLength(1);

    prisma.activationCode.createMany.mockClear();
    await service.generate({ selection: POOL_SELECTION as any, count: 9999 });
    expect(prisma.activationCode.createMany.mock.calls[0][0].data).toHaveLength(200);
  });

  it("目录未发布 → BadRequest,不生成", async () => {
    service = new ActivationCodeService(prisma, makeBilling(), makeSubscriptions(), makeCatalog(null));
    await expect(service.generate({ selection: POOL_SELECTION as any, count: 1 })).rejects.toThrow(BadRequestException);
    expect(prisma.activationCode.createMany).not.toHaveBeenCalled();
  });

  it("非法 selection(未知 usageTier)→ BadRequest,不生成", async () => {
    await expect(
      service.generate({ selection: { line: "pool", products: ["anthropic"], usageTier: "huge", deviceLimit: 1 } as any, count: 5 }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.activationCode.createMany).not.toHaveBeenCalled();
  });
});

describe("ActivationCodeService.activate", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let billing: any;
  let subscriptions: any;
  let service: ActivationCodeService;

  beforeEach(() => {
    prisma = makePrisma();
    billing = makeBilling();
    subscriptions = makeSubscriptions();
    service = new ActivationCodeService(prisma, billing, subscriptions, makeCatalog());
  });
  afterEach(() => vi.restoreAllMocks());

  function unusedCode(overrides: Record<string, any> = {}) {
    return { id: "ac-1", code: "AC-XXXX", selection: JSON.stringify(POOL_SELECTION), status: "UNUSED", activatedByCustomerId: null, subscriptionId: null, ...overrides };
  }

  it("UNUSED → 造 ACTIVATION_CODE 订单 + forceNew 激活订阅 + 标记 ACTIVATED(activatedAt/by/subscriptionId)", async () => {
    prisma.activationCode.findUnique.mockResolvedValue(unusedCode());

    const res = await service.activate("cust-1", "AC-XXXX");

    // 用 selection 造激活码订单。
    expect(billing.createActivationCodeOrder).toHaveBeenCalledWith("cust-1", POOL_SELECTION);
    // forceNew 激活(每张码独立订阅)。
    expect(subscriptions.activateForOrder).toHaveBeenCalledWith({ id: "code-order-1" }, { forceNew: true });
    // CAS 认领 UNUSED→ACTIVATED。
    expect(prisma.activationCode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ac-1", status: "UNUSED" } }),
    );
    const claim = prisma.activationCode.updateMany.mock.calls[0][0];
    expect(claim.data.status).toBe("ACTIVATED");
    expect(claim.data.activatedByCustomerId).toBe("cust-1");
    expect(claim.data.activatedAt).toBeInstanceOf(Date);
    // 回填 subscriptionId + 订阅审计回链。
    expect(prisma.activationCode.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ac-1" }, data: expect.objectContaining({ subscriptionId: "sub-new-1" }) }),
    );
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sub-new-1" }, data: { activatedFromActivationCodeId: "ac-1" } }),
    );
    expect(res.ok).toBe(true);
    expect(res.subscription).toMatchObject({ id: "sub-new-1", products: ["anthropic"], deviceLimit: 2 });
  });

  it("座位不足(造订单抛 BadRequest)→ 码回滚为 UNUSED,可重试,不开通订阅", async () => {
    prisma.activationCode.findUnique.mockResolvedValue(unusedCode());
    billing.createActivationCodeOrder.mockRejectedValue(new BadRequestException("暂无可用座位"));

    await expect(service.activate("cust-1", "AC-XXXX")).rejects.toThrow(BadRequestException);

    expect(subscriptions.activateForOrder).not.toHaveBeenCalled();
    // 回滚:把已认领的 ACTIVATED(未回填 subscriptionId)还原成 UNUSED。
    const revert = prisma.activationCode.updateMany.mock.calls.find(
      (c: any[]) => c[0]?.data?.status === "UNUSED",
    );
    expect(revert).toBeTruthy();
    expect(revert[0].where).toMatchObject({ id: "ac-1", status: "ACTIVATED", subscriptionId: null });
  });

  it("激活码不存在 → NotFound", async () => {
    prisma.activationCode.findUnique.mockResolvedValue(null);
    await expect(service.activate("cust-1", "NOPE")).rejects.toThrow(NotFoundException);
    expect(billing.createActivationCodeOrder).not.toHaveBeenCalled();
  });

  it("已停用 → BadRequest,不激活", async () => {
    prisma.activationCode.findUnique.mockResolvedValue(unusedCode({ status: "DISABLED" }));
    await expect(service.activate("cust-1", "AC-XXXX")).rejects.toThrow(BadRequestException);
    expect(billing.createActivationCodeOrder).not.toHaveBeenCalled();
  });

  it("已被他人激活 → Conflict", async () => {
    prisma.activationCode.findUnique.mockResolvedValue(
      unusedCode({ status: "ACTIVATED", activatedByCustomerId: "other", subscriptionId: "sub-x" }),
    );
    await expect(service.activate("cust-1", "AC-XXXX")).rejects.toThrow(ConflictException);
    expect(billing.createActivationCodeOrder).not.toHaveBeenCalled();
  });

  it("本人重复激活 → 幂等返回其订阅,不重复开通", async () => {
    prisma.activationCode.findUnique.mockResolvedValue(
      unusedCode({ status: "ACTIVATED", activatedByCustomerId: "cust-1", subscriptionId: "sub-mine" }),
    );
    prisma.subscription.findUnique.mockResolvedValue({
      id: "sub-mine",
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      productEntitlements: JSON.stringify(["anthropic"]),
      deviceLimit: 2,
    });

    const res = await service.activate("cust-1", "AC-XXXX");

    expect(res.ok).toBe(true);
    expect(res.alreadyActivated).toBe(true);
    expect(res.subscription.id).toBe("sub-mine");
    expect(billing.createActivationCodeOrder).not.toHaveBeenCalled();
    expect(subscriptions.activateForOrder).not.toHaveBeenCalled();
  });
});

describe("ActivationCodeService.list / disable(后台管理)", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: ActivationCodeService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new ActivationCodeService(prisma, makeBilling(), makeSubscriptions(), makeCatalog());
  });
  afterEach(() => vi.restoreAllMocks());

  it("list:按 status/batchId/search 过滤 + 分页,解析激活客户邮箱", async () => {
    prisma.activationCode.findMany.mockResolvedValue([
      { id: "ac-1", code: "AC-1", status: "ACTIVATED", selection: JSON.stringify(POOL_SELECTION), name: null, batchId: "b1", activatedAt: new Date("2026-06-20T00:00:00Z"), activatedByCustomerId: "cust-9", subscriptionId: "sub-9", createdAt: new Date("2026-06-19T00:00:00Z") },
      { id: "ac-2", code: "AC-2", status: "UNUSED", selection: JSON.stringify(POOL_SELECTION), name: null, batchId: "b1", activatedAt: null, activatedByCustomerId: null, subscriptionId: null, createdAt: new Date("2026-06-19T00:00:00Z") },
    ]);
    prisma.activationCode.count.mockResolvedValue(2);
    prisma.customer.findMany.mockResolvedValue([{ id: "cust-9", email: "user9@test.local" }]);

    const res = await service.list({ batchId: "b1", search: "AC", page: 1, pageSize: 20 });

    expect(prisma.activationCode.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ batchId: "b1", code: { contains: "AC" } }),
        skip: 0,
        take: 20,
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(res.total).toBe(2);
    expect(res.items[0]).toMatchObject({ id: "ac-1", code: "AC-1", status: "ACTIVATED", activatedByEmail: "user9@test.local" });
    expect(res.items[1]).toMatchObject({ id: "ac-2", status: "UNUSED", activatedByEmail: null });
  });

  it("disable:UNUSED → DISABLED(CAS)", async () => {
    prisma.activationCode.updateMany.mockResolvedValue({ count: 1 });
    const res = await service.disable("ac-1");
    expect(prisma.activationCode.updateMany).toHaveBeenCalledWith({
      where: { id: "ac-1", status: "UNUSED" },
      data: { status: "DISABLED" },
    });
    expect(res).toMatchObject({ ok: true, status: "DISABLED" });
  });

  it("disable:已激活的码不可停用 → Conflict(不影响其订阅)", async () => {
    prisma.activationCode.updateMany.mockResolvedValue({ count: 0 });
    prisma.activationCode.findUnique.mockResolvedValue({ id: "ac-1", status: "ACTIVATED" });
    await expect(service.disable("ac-1")).rejects.toThrow(ConflictException);
  });

  it("disable:不存在 → NotFound", async () => {
    prisma.activationCode.updateMany.mockResolvedValue({ count: 0 });
    prisma.activationCode.findUnique.mockResolvedValue(null);
    await expect(service.disable("nope")).rejects.toThrow(NotFoundException);
  });
});
