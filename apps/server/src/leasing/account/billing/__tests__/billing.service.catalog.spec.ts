/**
 * billing.service.catalog.spec.ts — catalog-driven order creation (spec §8).
 *
 * createCatalogOrder: take a selection → price it against the PUBLISHED catalog
 * via computePurchase → persist a PlanOrder (planId null; selection/config/
 * catalogVersion/amountCents snapshot) → return the epay payUrl. Mocked Prisma +
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
    ...overrides,
  } as any;
}

function makeCatalog(published: any = { version: 2, config: CATALOG_CONFIG }) {
  return { getPublished: vi.fn().mockResolvedValue(published) } as any;
}

const fixedCustomer = { id: "cust-1", invitedById: "referrer-1" };

describe("BillingService.createCatalogOrder", () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let catalog: any;
  let service: BillingService;

  beforeEach(() => {
    vi.stubEnv("EPAY_FEE_PERCENT", "0");
    vi.stubEnv("EPAY_PID", "1001");
    vi.stubEnv("EPAY_KEY", "test-key");
    prisma = makeMockPrisma();
    catalog = makeCatalog();
    service = new BillingService(prisma, catalog);

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

  it("号池线 selection → computePurchase 定价,订单存 config/selection/catalogVersion,planId null", async () => {
    const selection = { line: "pool", products: ["anthropic"], usageTier: "large", deviceLimit: 2 };

    const result = await service.createCatalogOrder("cust-1", selection as any, "ALIPAY");

    expect(prisma.planOrder.create).toHaveBeenCalledOnce();
    const data = prisma.planOrder.create.mock.calls[0][0].data;
    expect(data.planId).toBeNull();
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
