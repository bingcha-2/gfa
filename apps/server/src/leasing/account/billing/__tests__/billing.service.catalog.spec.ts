/**
 * billing.service.catalog.spec.ts — catalog-driven order creation (spec §8).
 *
 * createCatalogOrder: take a selection → price it against the PUBLISHED catalog
 * via computePurchase → persist a PlanOrder (selection/config/catalogVersion/
 * amountCents snapshot) → return the epay payUrl. Mocked Prisma +
 * PlanCatalogService; no real DB.
 */
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BillingService } from "../billing.service";
import { BadRequestException } from "@nestjs/common";

// A minimal but valid catalog config (spec §4.1 shape) for pool + bind pricing.
const CATALOG_CONFIG = {
  products: ["anthropic", "codex"],
  levels: { anthropic: ["pro", "max-20x"], codex: ["plus"] },
  usageTiers: {
    small: { bucketLimits: { "anthropic-claude": 50000 }, weeklyTokenLimit: 250000 },
    large: { bucketLimits: { "anthropic-claude": 150000 }, weeklyTokenLimit: 750000 },
  },
  pricing: {
    pool: { product: { anthropic: 6900, codex: 3900 }, usage: { small: 0, large: 3000 }, devicePerExtra: 900 },
    bind: {
      levelPrice: { anthropic: { pro: 9900, "max-20x": 29900 }, codex: { plus: 13900 } },
      share: { "1": 0, "2": -4000, "4": -7000, "8": -9000 },
      devicePerExtra: 900,
    },
  },
  durationDays: 30,
  windowMs: 18_000_000,
};

function makeMockPrisma(overrides: Record<string, any> = {}) {
  return {
    customer: { findUnique: vi.fn() },
    planOrder: { create: vi.fn() },
    // 绑定线下单前座位预检要读 DB ACTIVE 订阅的 config 算占用份额(默认无订阅)。
    subscription: { findMany: vi.fn().mockResolvedValue([]) },
    ...overrides,
  } as any;
}

function makeCatalog(published: any = { version: 2, config: CATALOG_CONFIG }) {
  return { getPublished: vi.fn().mockResolvedValue(published) } as any;
}

/** Mock RosettaService:默认每个产品都有可用座位(预检放行);测试可按需改 mock。 */
function makeRosetta(hasSeat = true) {
  return { hasAvailableSeatFromShares: vi.fn().mockReturnValue(hasSeat) } as any;
}

const fixedCustomer = { id: "cust-1", invitedById: "referrer-1" };

describe("BillingService.createCatalogOrder", () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let catalog: any;
  let rosetta: any;
  let service: BillingService;

  beforeEach(() => {
    vi.stubEnv("EPAY_FEE_PERCENT", "0");
    vi.stubEnv("EPAY_PID", "1001");
    vi.stubEnv("EPAY_KEY", "test-key");
    prisma = makeMockPrisma();
    catalog = makeCatalog();
    rosetta = makeRosetta();
    service = new BillingService(prisma, catalog, rosetta);

    prisma.customer.findUnique.mockResolvedValue(fixedCustomer);
    prisma.planOrder.create.mockImplementation(async ({ data }: any) => ({
      id: "catalog-order-1",
      outTradeNo: data.outTradeNo,
      amountCents: data.amountCents,
      payChannel: data.payChannel,
      status: "PENDING",
      expiresAt: data.expiresAt,
      referrerId: data.referrerId,
      createdAt: new Date(),
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("号池线 selection → computePurchase 定价,订单存 config/selection/catalogVersion", async () => {
    const selection = { line: "pool", products: ["anthropic"], usageTier: "large", deviceLimit: 2 };

    const result = await service.createCatalogOrder("cust-1", selection as any, "ALIPAY");

    expect(prisma.planOrder.create).toHaveBeenCalledOnce();
    const data = prisma.planOrder.create.mock.calls[0][0].data;
    expect(data.customerId).toBe("cust-1");
    expect(data.catalogVersion).toBe(2);
    // 价格 = anthropic 6900 + large 3000 + 1 台额外设备 900 = 10800 分。
    expect(data.amountCents).toBe(10800);
    expect(data.status).toBe("PENDING");
    expect(data.referrerId).toBe("referrer-1");
    // selection 原样快照,config 为 computePurchase 生成(含 line=pool)。
    expect(JSON.parse(data.selection)).toEqual(selection);
    const config = JSON.parse(data.config);
    expect(config).toMatchObject({
      line: "pool",
      products: ["anthropic"],
      bucketLimits: { "anthropic-claude": 150000 },
      weeklyTokenLimit: 750000,
      deviceLimit: 2,
      windowMs: 18_000_000,
    });

    // 返回 epay 支付信息。
    expect(result.amountCents).toBe(10800);
    expect(result.payUrl).toContain("money=108.00");
    expect(result.payUrl).toMatch(/sign=[0-9a-f]{32}/);
    expect(result.qrDataUri).toMatch(/^data:image\/png;base64,/);
  });

  it("绑定线 selection → 价格叠加共享人数折扣,config.line=bind + levels + weight", async () => {
    const selection = {
      line: "bind",
      items: [{ product: "anthropic", level: "max-20x" }],
      shareUsers: 2,
      deviceLimit: 1,
    };

    await service.createCatalogOrder("cust-1", selection as any, "WXPAY");

    const data = prisma.planOrder.create.mock.calls[0][0].data;
    // 29900 (max-20x) + share[2] = -4000 + 0 额外设备 = 25900 分。
    expect(data.amountCents).toBe(25900);
    const config = JSON.parse(data.config);
    expect(config).toMatchObject({
      line: "bind",
      products: ["anthropic"],
      levels: { anthropic: "max-20x" },
      weight: 4, // capacity 8 / 2 人
      deviceLimit: 1,
    });
  });

  it("没有 PUBLISHED catalog → BadRequest(目录未发布,不能下单)", async () => {
    catalog.getPublished.mockResolvedValue(null);
    await expect(
      service.createCatalogOrder("cust-1", { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 } as any, "ALIPAY"),
    ).rejects.toThrow(BadRequestException);
  });

  it("非法 selection(未知 usageTier)→ 抛错,不建订单", async () => {
    await expect(
      service.createCatalogOrder("cust-1", { line: "pool", products: ["anthropic"], usageTier: "huge", deviceLimit: 1 } as any, "ALIPAY"),
    ).rejects.toThrow();
    expect(prisma.planOrder.create).not.toHaveBeenCalled();
  });

  it("amountCents 计入 EPAY_FEE_PERCENT 手续费(用户承担,向上取整到分)", async () => {
    vi.stubEnv("EPAY_FEE_PERCENT", "3"); // 10800 * 3% = 324 分
    const result = await service.createCatalogOrder(
      "cust-1",
      { line: "pool", products: ["anthropic"], usageTier: "large", deviceLimit: 2 } as any,
      "ALIPAY",
    );
    const data = prisma.planOrder.create.mock.calls[0][0].data;
    expect(data.amountCents).toBe(11124); // 10800 + 324
    expect(result.baseCents).toBe(10800);
    expect(result.feeCents).toBe(324);
  });
});

// 下单前座位预检(spec §10):绑定线下单前确认每个 product+level 有可用座位,
// 无座位 → 拒绝下单(避免用户付钱拿不到号)。号池线不预检。
describe("BillingService.createCatalogOrder — 绑定线座位预检(spec §10)", () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let catalog: any;
  let rosetta: any;
  let service: BillingService;

  beforeEach(() => {
    vi.stubEnv("EPAY_FEE_PERCENT", "0");
    vi.stubEnv("EPAY_PID", "1001");
    vi.stubEnv("EPAY_KEY", "test-key");
    prisma = makeMockPrisma();
    catalog = makeCatalog();
    rosetta = makeRosetta();
    service = new BillingService(prisma, catalog, rosetta);

    prisma.customer.findUnique.mockResolvedValue(fixedCustomer);
    prisma.planOrder.create.mockImplementation(async ({ data }: any) => ({
      id: "catalog-order-1",
      outTradeNo: data.outTradeNo,
      amountCents: data.amountCents,
      payChannel: data.payChannel,
      status: "PENDING",
      expiresAt: data.expiresAt,
      referrerId: data.referrerId,
      createdAt: new Date(),
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const bindSelection = {
    line: "bind",
    items: [{ product: "anthropic", level: "max-20x" }],
    shareUsers: 2, // → weight 4
    deviceLimit: 1,
  };

  it("有可用座位 → 放行建单;按 (product, weight=config.weight, level, occupiedShares) 预检", async () => {
    await service.createCatalogOrder("cust-1", bindSelection as any, "WXPAY");

    expect(rosetta.hasAvailableSeatFromShares).toHaveBeenCalledOnce();
    const [product, weight, level, occupied] = rosetta.hasAvailableSeatFromShares.mock.calls[0];
    expect(product).toBe("anthropic");
    expect(weight).toBe(4); // capacity 8 / 2 人,与 config.weight 一致
    expect(level).toBe("max-20x");
    expect(occupied).toBeInstanceOf(Map);
    expect(prisma.planOrder.create).toHaveBeenCalledOnce();
  });

  it("无可用座位 → BadRequest 拒绝下单,不建订单(避免付钱拿不到号)", async () => {
    rosetta.hasAvailableSeatFromShares.mockReturnValue(false);

    await expect(
      service.createCatalogOrder("cust-1", bindSelection as any, "WXPAY"),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.planOrder.create).not.toHaveBeenCalled();
  });

  it("多产品:任一产品无座位 → 整单拒绝", async () => {
    const multi = {
      line: "bind",
      items: [
        { product: "anthropic", level: "pro" },
        { product: "codex", level: "plus" },
      ],
      shareUsers: 1,
      deviceLimit: 1,
    };
    // anthropic 有座位,codex 没有。
    rosetta.hasAvailableSeatFromShares.mockImplementation((p: string) => p !== "codex");

    await expect(service.createCatalogOrder("cust-1", multi as any, "ALIPAY")).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.planOrder.create).not.toHaveBeenCalled();
  });

  it("号池线不预检:不调 hasAvailableSeatFromShares,直接建单", async () => {
    await service.createCatalogOrder(
      "cust-1",
      { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 } as any,
      "ALIPAY",
    );
    expect(rosetta.hasAvailableSeatFromShares).not.toHaveBeenCalled();
    expect(prisma.planOrder.create).toHaveBeenCalledOnce();
  });

  it("占用份额从 DB ACTIVE 订阅 config 算(按 product 汇总 weight),传给预检", async () => {
    // 一条已绑 anthropic #7、weight 4 的 ACTIVE 订阅 → 该号已占 4 份。
    prisma.subscription.findMany.mockResolvedValue([
      { id: "sub-existing", config: JSON.stringify({ line: "bind", bindings: { anthropic: 7 }, weight: 4 }) },
    ]);

    await service.createCatalogOrder("cust-1", bindSelection as any, "WXPAY");

    const [, , , occupied] = rosetta.hasAvailableSeatFromShares.mock.calls[0];
    expect(occupied.get(7)).toBe(4);
    // 只查 ACTIVE 订阅。
    expect(prisma.subscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "ACTIVE" } }),
    );
  });
});

// 管理员手动授予(目录版):不走支付,落一条 ¥0 / status=PAID / payChannel=GRANT 的订单,
// 复用 computePurchase 算 config + 绑定线座位预检。激活由调用方走 activateForOrder(同付费)。
describe("BillingService.createGrantOrder(目录版手动授予)", () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let catalog: any;
  let rosetta: any;
  let service: BillingService;

  beforeEach(() => {
    prisma = makeMockPrisma();
    catalog = makeCatalog();
    rosetta = makeRosetta();
    service = new BillingService(prisma, catalog, rosetta);
    prisma.customer.findUnique.mockResolvedValue(fixedCustomer);
    prisma.planOrder.create.mockImplementation(async ({ data }: any) => ({ id: "grant-order-1", ...data }));
  });

  afterEach(() => vi.restoreAllMocks());

  it("号池授予 → ¥0、PAID、GRANT,带 config/selection/catalogVersion;号池不预检座位", async () => {
    const selection = { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 };

    const order = await service.createGrantOrder("cust-1", selection as any);

    const data = prisma.planOrder.create.mock.calls[0][0].data;
    expect(data.amountCents).toBe(0);
    expect(data.payChannel).toBe("GRANT");
    expect(data.status).toBe("PAID");
    expect(data.paidAt).toBeInstanceOf(Date);
    expect(data.catalogVersion).toBe(2);
    expect(data.referrerId).toBe("referrer-1");
    expect(JSON.parse(data.selection)).toEqual(selection);
    expect(JSON.parse(data.config)).toMatchObject({ line: "pool", products: ["anthropic"] });
    expect(rosetta.hasAvailableSeatFromShares).not.toHaveBeenCalled(); // 号池线不预检
    expect(order.id).toBe("grant-order-1");
  });

  it("绑定授予 → 走座位预检(与付费同口径);无座位 → BadRequest,不建订单", async () => {
    rosetta.hasAvailableSeatFromShares.mockReturnValue(false);
    const selection = { line: "bind", items: [{ product: "anthropic", level: "max-20x" }], shareUsers: 2, deviceLimit: 1 };

    await expect(service.createGrantOrder("cust-1", selection as any)).rejects.toThrow(BadRequestException);
    expect(prisma.planOrder.create).not.toHaveBeenCalled();
  });

  it("目录未发布 → BadRequest(无法授予)", async () => {
    catalog.getPublished.mockResolvedValue(null);
    await expect(
      service.createGrantOrder("cust-1", { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 } as any),
    ).rejects.toThrow(BadRequestException);
  });
});
