/**
 * billing.service.catalog.spec.ts — catalog-driven order creation (spec §8).
 *
 * createCatalogOrder: take a selection → price it against the PUBLISHED catalog
 * via computePurchase → persist a PlanOrder (selection/config/catalogVersion/
 * amountCents snapshot) → return the epay payUrl. Mocked Prisma +
 * PlanCatalogService; no real DB.
 */
import "reflect-metadata";
import * as crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BillingService } from "../billing.service";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";

// V2 下单用商户私钥 RSA 签名 —— 生成一个测试私钥(裸 base64 PKCS#8)喂给 EPAY_MERCHANT_PRIVATE_KEY。
const TEST_PRIV_B64 = crypto
  .generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "der" })
  .toString("base64");

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
  const prisma: any = {
    // findUniqueOrThrow/updateMany/update 供余额抵扣(applyCredit / void* / 退款回补)用。
    customer: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ creditCents: 0 }),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    // 不再复用旧单:新建前在事务里作废该客户所有 PENDING 单并回补余额(findMany 默认无旧单)。
    // findUnique 供 getOrder / cancelOrder / voidPendingOrder 用。
    planOrder: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    // 绑定线下单前座位预检要读 DB ACTIVE 订阅的 config 算占用份额(默认无订阅)。
    subscription: { findMany: vi.fn().mockResolvedValue([]) },
    ...overrides,
  };
  // $transaction:回调式 → 用同一 mock 当 tx;数组式 → Promise.all。
  prisma.$transaction = vi.fn(async (arg: any) =>
    typeof arg === "function" ? arg(prisma) : Promise.all(arg),
  );
  return prisma as any;
}

function makeCatalog(published: any = { version: 2, config: CATALOG_CONFIG }) {
  return { getPublished: vi.fn().mockResolvedValue(published) } as any;
}

/** Mock RosettaService:默认每个产品都有可用座位(预检放行);测试可按需改 mock。 */
function makeRosetta(hasSeat = true) {
  return { hasAvailableSeatFromShares: vi.fn().mockReturnValue(hasSeat) } as any;
}

const EPAY_CASHIER_URL = "https://gw.test/pay/cashier";

/**
 * buildEpayPayUrl POSTs to the live zhunfu gateway. Stub fetch so the happy path
 * completes offline with a deterministic cashier URL. Returns the mock so tests can
 * assert the signed V2 request (the money/sign/timestamp live in the POST body now,
 * not in the returned payUrl). Cleared by vi.unstubAllGlobals() in afterEach.
 */
function stubEpayGateway() {
  const fetchMock = vi.fn(async (_url?: unknown, _init?: unknown) => ({
    text: async () => `<script>window.location.replace('${EPAY_CASHIER_URL}')</script>`,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const fixedCustomer = { id: "cust-1", invitedById: "referrer-1", emailVerified: true };

describe("BillingService.createCatalogOrder", () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let catalog: any;
  let rosetta: any;
  let service: BillingService;
  let fetchMock: ReturnType<typeof stubEpayGateway>;

  beforeEach(() => {
    vi.stubEnv("EPAY_FEE_PERCENT", "0");
    vi.stubEnv("EPAY_PID", "1001");
    vi.stubEnv("EPAY_MERCHANT_PRIVATE_KEY", TEST_PRIV_B64);
    fetchMock = stubEpayGateway();
    prisma = makeMockPrisma();
    catalog = makeCatalog();
    rosetta = makeRosetta();
    service = new BillingService(prisma, catalog, rosetta, {} as any, {} as any);

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
    vi.unstubAllGlobals();
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

    // 返回 epay V2 支付信息:payUrl 是网关返回的收银台地址,二维码由它生成。
    expect(result.amountCents).toBe(10800);
    expect(result.payUrl).toBe(EPAY_CASHIER_URL);
    expect(result.qrDataUri).toMatch(/^data:image\/png;base64,/);
    // V2 下单是 POST /api/pay/submit,money/sign/timestamp 在请求体里(不再拼进 payUrl)。
    const [submitUrl, init] = fetchMock.mock.calls[0];
    expect(String(submitUrl)).toContain("/api/pay/submit"); // V2 接口(非 submit.php)
    const reqBody = new URLSearchParams((init as any).body as string);
    expect(reqBody.get("money")).toBe("108.00");
    expect(reqBody.get("sign_type")).toBe("RSA");
    expect(reqBody.get("sign")).toBeTruthy(); // RSA base64 签名
    expect(reqBody.get("timestamp")).toMatch(/^\d{10}$/); // V2 必填 timestamp
    expect(reqBody.get("out_trade_no")).toBe(data.outTradeNo);
  });

  it("绑定线 selection → 价格按席摊算 + share 折扣,config.line=bind + levels + weight", async () => {
    const selection = {
      line: "bind",
      items: [{ product: "anthropic", level: "max-20x" }],
      shareSeats: 4, // 占 4/8 席(= 2 人拼车,每人 4 席)
      deviceLimit: 1,
    };

    await service.createCatalogOrder("cust-1", selection as any, "WXPAY");

    const data = prisma.planOrder.create.mock.calls[0][0].data;
    // 按席摊算:29900 (max-20x) × 4/8 = 14950 + share[4] = -7000 + 0 额外设备 = 7950 分。
    expect(data.amountCents).toBe(7950);
    const config = JSON.parse(data.config);
    expect(config).toMatchObject({
      line: "bind",
      products: ["anthropic"],
      levels: { anthropic: "max-20x" },
      weight: 4, // capacity 8 / 2 人
      deviceLimit: 1,
    });
  });

  it("enriches bind catalog orders with sales-seat capacity + pinned policy (no static entitlements — fair-share governs)", async () => {
    const selection = {
      line: "bind",
      items: [{ product: "anthropic", level: "max-20x" }],
      shareSeats: 2,
      deviceLimit: 1,
    };

    await service.createCatalogOrder("cust-1", selection as any, "WXPAY");

    const cfg = JSON.parse(prisma.planOrder.create.mock.calls[0][0].data.config);
    expect(cfg).toMatchObject({
      line: "bind",
      shareSeats: 2,
      salesSeatCapacity: { anthropic: 10 },
      assignmentPolicy: "pinned",
    });
    // 绑定卡额度归 fair-share —— 不再下发静态 bucketLimits/weeklyBucketLimits。
    expect(cfg.bucketLimits).toBeUndefined();
    expect(cfg.weeklyBucketLimits).toBeUndefined();
  });

  it("enriches antigravity bind orders as display-bound pool with weighted token buckets", async () => {
    catalog.getPublished.mockResolvedValueOnce({
      version: 9,
      config: {
        ...CATALOG_CONFIG,
        products: ["antigravity"],
        levels: { antigravity: ["ultra"] },
        pricing: {
          pool: { product: { antigravity: 3900 }, usage: { small: 0 }, devicePerExtra: 900 },
          bind: {
            levelPrice: { antigravity: { ultra: 19900 } },
            share: { "1": 0, "2": 0, "4": 0, "8": 0 },
            devicePerExtra: 900,
          },
        },
      },
    });
    const selection = {
      line: "bind",
      items: [{ product: "antigravity", level: "ultra" }],
      shareSeats: 1,
      deviceLimit: 1,
    };

    await service.createCatalogOrder("cust-1", selection as any, "WXPAY");

    const cfg = JSON.parse(prisma.planOrder.create.mock.calls[0][0].data.config);
    expect(cfg).toMatchObject({
      line: "bind",
      products: ["antigravity"],
      levels: { antigravity: "ultra" },
      shareSeats: 1,
      shareCapacity: 8,
      weight: 1,
      salesSeatCapacity: { antigravity: 10 },
      assignmentPolicy: "display-bound-pool",
      bucketLimits: {
        "antigravity-gemini": 12_500_000,
        "antigravity-claude": 1_500_000,
      },
      weeklyBucketLimits: {
        "antigravity-gemini": 50_000_000,
        "antigravity-claude": 5_000_000,
      },
    });
  });

  it("keeps mixed bind orders pinned so codex or anthropic are not moved onto antigravity's pool policy", async () => {
    catalog.getPublished.mockResolvedValueOnce({
      version: 10,
      config: {
        ...CATALOG_CONFIG,
        products: ["antigravity", "codex"],
        levels: { antigravity: ["ultra"], codex: ["pro"] },
        pricing: {
          pool: { product: { antigravity: 3900, codex: 3900 }, usage: { small: 0 }, devicePerExtra: 900 },
          bind: {
            levelPrice: { antigravity: { ultra: 19900 }, codex: { pro: 19900 } },
            share: { "1": 0, "2": 0, "4": 0, "8": 0 },
            devicePerExtra: 900,
          },
        },
      },
    });
    const selection = {
      line: "bind",
      items: [
        { product: "antigravity", level: "ultra" },
        { product: "codex", level: "pro" },
      ],
      shareSeats: 1,
      deviceLimit: 1,
    };

    await service.createCatalogOrder("cust-1", selection as any, "WXPAY");

    const cfg = JSON.parse(prisma.planOrder.create.mock.calls[0][0].data.config);
    expect(cfg).toMatchObject({
      line: "bind",
      products: ["antigravity", "codex"],
      levels: { antigravity: "ultra", codex: "pro" },
      salesSeatCapacity: { antigravity: 10, codex: 10 },
      assignmentPolicy: "pinned",
    });
    expect(cfg.bucketLimits).toBeUndefined();
    expect(cfg.weeklyBucketLimits).toBeUndefined();
  });

  it("没有 PUBLISHED catalog → BadRequest(目录未发布,不能下单)", async () => {
    catalog.getPublished.mockResolvedValue(null);
    await expect(
      service.createCatalogOrder("cust-1", { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 } as any, "ALIPAY"),
    ).rejects.toThrow(BadRequestException);
  });

  it("邮箱未验证 → Forbidden(EMAIL_NOT_VERIFIED),不建订单", async () => {
    prisma.customer.findUnique.mockResolvedValue({ ...fixedCustomer, emailVerified: false });
    await expect(
      service.createCatalogOrder("cust-1", { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 } as any, "ALIPAY"),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.planOrder.create).not.toHaveBeenCalled();
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
    vi.stubEnv("EPAY_MERCHANT_PRIVATE_KEY", TEST_PRIV_B64);
    stubEpayGateway();
    prisma = makeMockPrisma();
    catalog = makeCatalog();
    rosetta = makeRosetta();
    service = new BillingService(prisma, catalog, rosetta, {} as any, {} as any);

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
    vi.unstubAllGlobals();
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
    const [product, weight, level, occupied, salesCapacity] = rosetta.hasAvailableSeatFromShares.mock.calls[0];
    expect(product).toBe("anthropic");
    expect(weight).toBe(4); // capacity 8 / 2 人,与 config.weight 一致
    expect(level).toBe("max-20x");
    expect(occupied).toBeInstanceOf(Map);
    expect(salesCapacity).toBe(10);
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

  it("座位预检用 rowToConfig 回退 legacy 绑定列,避免坏 config 漏算占用", async () => {
    prisma.subscription.findMany.mockResolvedValue([
      {
        id: "sub-legacy",
        config: "{bad-json",
        productEntitlements: JSON.stringify(["anthropic"]),
        bindings: JSON.stringify({ anthropic: 7 }),
        levels: JSON.stringify({ anthropic: "max-20x" }),
        weight: 4,
        deviceLimit: 1,
        weeklyTokenLimit: null,
        bucketLimits: null,
        windowMs: 18_000_000,
      },
    ]);

    await service.createCatalogOrder("cust-1", bindSelection as any, "WXPAY");

    const [, , , occupied] = rosetta.hasAvailableSeatFromShares.mock.calls[0];
    expect(occupied.get(7)).toBe(4);
    expect(prisma.subscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          config: true,
          productEntitlements: true,
          bindings: true,
          levels: true,
          weight: true,
        }),
      }),
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
    service = new BillingService(prisma, catalog, rosetta, {} as any, {} as any);
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

  it("enriches bind grant orders with sales-seat capacity + pinned policy (no static entitlements)", async () => {
    const selection = {
      line: "bind",
      items: [{ product: "anthropic", level: "max-20x" }],
      shareSeats: 2,
      deviceLimit: 1,
    };

    await service.createGrantOrder("cust-1", selection as any);

    const cfg = JSON.parse(prisma.planOrder.create.mock.calls[0][0].data.config);
    expect(cfg).toMatchObject({
      line: "bind",
      shareSeats: 2,
      assignmentPolicy: "pinned",
    });
    expect(cfg.bucketLimits).toBeUndefined();
    expect(cfg.weeklyBucketLimits).toBeUndefined();
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

// 不复用旧单:每次选购都是一笔全新订单。新建前(校验全过后)把该客户所有 PENDING 单作废,
// 避免多个有效二维码被重复扫码支付 —— 同时根治「旧单锁价 + 目录改价 → 差额错算成手续费」。
describe("BillingService.createCatalogOrder — 作废旧单(不复用)", () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let catalog: any;
  let rosetta: any;
  let service: BillingService;

  const selection = { line: "pool", products: ["anthropic"], usageTier: "large", deviceLimit: 2 };

  beforeEach(() => {
    vi.stubEnv("EPAY_FEE_PERCENT", "0");
    vi.stubEnv("EPAY_PID", "1001");
    vi.stubEnv("EPAY_MERCHANT_PRIVATE_KEY", TEST_PRIV_B64);
    stubEpayGateway(); // 下单走 buildEpayPayUrl→网关,离线 stub 掉(本组只断言 updateMany/create)
    prisma = makeMockPrisma();
    catalog = makeCatalog();
    rosetta = makeRosetta();
    service = new BillingService(prisma, catalog, rosetta, {} as any, {} as any);
    prisma.customer.findUnique.mockResolvedValue(fixedCustomer);
    prisma.planOrder.create.mockImplementation(async ({ data }: any) => ({
      id: "new-order",
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("新建前作废该客户所有 PENDING 旧单(PENDING→CANCELLED + 清零 creditAppliedCents),并新建一笔全新单", async () => {
    // 事务里先 findMany 出旧 PENDING 单(各自 creditAppliedCents),再 updateMany 作废。
    prisma.planOrder.findMany.mockResolvedValueOnce([
      { id: "old-1", creditAppliedCents: 0 },
      { id: "old-2", creditAppliedCents: 0 },
    ]);

    const result = await service.createCatalogOrder("cust-1", selection as any, "ALIPAY");

    // 作废:仅按 customer + PENDING 过滤,翻成 CANCELLED 并清零抵扣额(GRANT 单是 PAID 不在范围)。
    expect(prisma.planOrder.updateMany).toHaveBeenCalledWith({
      where: { customerId: "cust-1", status: "PENDING" },
      data: { status: "CANCELLED", creditAppliedCents: 0 },
    });
    // 始终新建(不复用任何旧单)。
    expect(prisma.planOrder.create).toHaveBeenCalledOnce();
    expect(result.outTradeNo).toBe(prisma.planOrder.create.mock.calls[0][0].data.outTradeNo);
  });

  it("无 PENDING 旧单(count:0)→ 照常新建", async () => {
    prisma.planOrder.updateMany.mockResolvedValue({ count: 0 });
    await service.createCatalogOrder("cust-1", selection as any, "ALIPAY");
    expect(prisma.planOrder.create).toHaveBeenCalledOnce();
  });

  // 回归:复现本次线上「¥2 套餐收 ¥214.53 手续费」的根因 —— 旧单锁 vX 毛额、弹窗按 vY 现价算 base,
  // feeCents=毛额−base 跨版本错配。去复用后每单 base/fee/amount 同源于一次 computePurchase,
  // feeCents=ceil(base×费率) 正算,不变式 amount=base+fee 恒成立。用真实数字钉死,防回退。
  it("回归:目录改价后新建,base/fee/amount 全出自新版,feeCents 不再跨版本错配", async () => {
    vi.stubEnv("EPAY_FEE_PERCENT", "3.6"); // 本次线上费率
    const bind = { line: "bind", items: [{ product: "anthropic", level: "max-20x" }], shareSeats: 8, deviceLimit: 1 };

    // 旧目录 v4:max-20x ¥299 × 8/8 + share[8] −¥90 = base ¥209;amount = 20900 + ceil(20900×3.6%) = 21653(¥216.53)。
    catalog.getPublished.mockResolvedValueOnce({ version: 4, config: CATALOG_CONFIG });
    const first = await service.createCatalogOrder("cust-1", bind as any, "ALIPAY");
    expect(first.baseCents).toBe(20900);
    expect(first.feeCents).toBe(753);
    expect(first.amountCents).toBe(21653);
    expect(first.amountCents).toBe(first.baseCents + first.feeCents); // 不变式

    // 目录改价重发到 v8:max-20x 降到 ¥92 → base = 9200 − 9000 = 200(¥2)。
    const v8 = JSON.parse(JSON.stringify(CATALOG_CONFIG));
    v8.pricing.bind.levelPrice.anthropic["max-20x"] = 9200;
    catalog.getPublished.mockResolvedValueOnce({ version: 8, config: v8 });
    const second = await service.createCatalogOrder("cust-1", bind as any, "ALIPAY");

    // 第二单完全按新版算:base ¥2,fee = ceil(200×3.6%) = 8,amount ¥2.08;旧版 ¥216.53 毛额绝不泄漏。
    expect(second.baseCents).toBe(200);
    expect(second.feeCents).toBe(8);
    expect(second.amountCents).toBe(208);
    expect(second.amountCents).toBe(second.baseCents + second.feeCents); // 关键不变式
    expect(second.feeCents).not.toBe(21453); // 老 bug 的值(21653−200),显式钉死不复发
  });

  it("作废发生在校验之后:绑定线无座位 → 不作废、不新建(BadRequest)", async () => {
    rosetta.hasAvailableSeatFromShares.mockReturnValue(false);
    const bind = { line: "bind", items: [{ product: "anthropic", level: "max-20x" }], shareUsers: 2, deviceLimit: 1 };

    await expect(service.createCatalogOrder("cust-1", bind as any, "WXPAY")).rejects.toThrow(BadRequestException);

    expect(prisma.planOrder.updateMany).not.toHaveBeenCalled(); // 校验失败 → 旧单不能被误废
    expect(prisma.planOrder.create).not.toHaveBeenCalled();
  });

  it("目录未发布 → 不作废、不新建", async () => {
    catalog.getPublished.mockResolvedValue(null);
    await expect(service.createCatalogOrder("cust-1", selection as any, "ALIPAY")).rejects.toThrow(BadRequestException);
    expect(prisma.planOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.planOrder.create).not.toHaveBeenCalled();
  });
});

// 激活码兑换内部订单:不走支付,落一条 status=PAID / payChannel=ACTIVATION_CODE 的订单,
// 与 GRANT 的唯一区别是 amountCents 记「激活当时目录算出的真实价格」(对账/营收可见),而非 ¥0。
// 复用 computePurchase 算 config + 绑定线座位预检(无座位 → 不建单,激活码保持 UNUSED)。
describe("BillingService.createActivationCodeOrder(激活码兑换)", () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let catalog: any;
  let rosetta: any;
  let service: BillingService;

  beforeEach(() => {
    prisma = makeMockPrisma();
    catalog = makeCatalog();
    rosetta = makeRosetta();
    service = new BillingService(prisma, catalog, rosetta, {} as any, {} as any);
    prisma.customer.findUnique.mockResolvedValue(fixedCustomer);
    prisma.planOrder.create.mockImplementation(async ({ data }: any) => ({ id: "code-order-1", ...data }));
  });

  afterEach(() => vi.restoreAllMocks());

  it("号池激活 → 记真实价格、PAID、ACTIVATION_CODE,带 config/selection/catalogVersion;号池不预检", async () => {
    const selection = { line: "pool", products: ["anthropic"], usageTier: "large", deviceLimit: 2 };

    const order = await service.createActivationCodeOrder("cust-1", selection as any);

    const data = prisma.planOrder.create.mock.calls[0][0].data;
    // 价格 = anthropic 6900 + large 3000 + 1 台额外设备 900 = 10800 分(真实价,非 ¥0)。
    expect(data.amountCents).toBe(10800);
    expect(data.payChannel).toBe("ACTIVATION_CODE");
    expect(data.status).toBe("PAID");
    expect(data.paidAt).toBeInstanceOf(Date);
    expect(data.catalogVersion).toBe(2);
    expect(JSON.parse(data.selection)).toEqual(selection);
    expect(JSON.parse(data.config)).toMatchObject({ line: "pool", products: ["anthropic"] });
    expect(rosetta.hasAvailableSeatFromShares).not.toHaveBeenCalled(); // 号池线不预检
    expect(order.id).toBe("code-order-1");
  });

  it("绑定激活 → 价格按席摊算,走座位预检(与付费同口径)", async () => {
    const selection = { line: "bind", items: [{ product: "anthropic", level: "max-20x" }], shareSeats: 4, deviceLimit: 1 };

    await service.createActivationCodeOrder("cust-1", selection as any);

    const data = prisma.planOrder.create.mock.calls[0][0].data;
    // 29900 × 4/8 = 14950 + share[4] −7000 = 7950 分。
    expect(data.amountCents).toBe(7950);
    expect(data.payChannel).toBe("ACTIVATION_CODE");
    expect(rosetta.hasAvailableSeatFromShares).toHaveBeenCalledOnce();
    const cfg = JSON.parse(data.config);
    expect(cfg).toMatchObject({ line: "bind", products: ["anthropic"], levels: { anthropic: "max-20x" }, assignmentPolicy: "pinned" });
  });

  it("绑定激活无可用座位 → BadRequest,不建订单(激活码保持 UNUSED 的前提)", async () => {
    rosetta.hasAvailableSeatFromShares.mockReturnValue(false);
    const selection = { line: "bind", items: [{ product: "anthropic", level: "max-20x" }], shareUsers: 2, deviceLimit: 1 };

    await expect(service.createActivationCodeOrder("cust-1", selection as any)).rejects.toThrow(BadRequestException);
    expect(prisma.planOrder.create).not.toHaveBeenCalled();
  });

  it("目录未发布 → BadRequest(无法激活)", async () => {
    catalog.getPublished.mockResolvedValue(null);
    await expect(
      service.createActivationCodeOrder("cust-1", { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 } as any),
    ).rejects.toThrow(BadRequestException);
  });
});

// 取消订单:仅 PENDING 可取消;取消前查网关(已支付则激活,绝不丢钱);其余状态幂等原样返回。
describe("BillingService.cancelOrder", () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let service: BillingService;

  beforeEach(() => {
    prisma = makeMockPrisma();
    service = new BillingService(prisma, makeCatalog(), makeRosetta(), {} as any, {} as any);
  });

  afterEach(() => vi.restoreAllMocks());

  it("PENDING 且网关未支付 → CAS 置 CANCELLED(回补余额),返回 CANCELLED", async () => {
    const pending = { id: "o1", customerId: "cust-1", outTradeNo: "gfa-1", status: "PENDING", paidAt: null, subscriptionId: null, creditAppliedCents: 0 };
    prisma.planOrder.findUnique
      .mockResolvedValueOnce(pending) // 首次读取(归属校验)
      .mockResolvedValueOnce(pending) // voidPendingOrder 事务里按 id 复读
      .mockResolvedValueOnce({ ...pending, status: "CANCELLED" }); // 作废后回读
    prisma.planOrder.updateMany.mockResolvedValue({ count: 1 });
    const syncSpy = vi.spyOn(service, "queryAndSyncEpayOrder").mockResolvedValue(false);

    const res = await service.cancelOrder("cust-1", "gfa-1");

    expect(syncSpy).toHaveBeenCalledWith("gfa-1"); // 取消前兜底查一次网关
    // voidPendingOrder:CAS by id,翻 CANCELLED 并清零抵扣额。
    expect(prisma.planOrder.updateMany).toHaveBeenCalledWith({
      where: { id: "o1", status: "PENDING" },
      data: { status: "CANCELLED", creditAppliedCents: 0 },
    });
    expect(res.status).toBe("CANCELLED");
  });

  it("PENDING 但网关已支付 → 不取消,激活后返回 PAID", async () => {
    const pending = { id: "o1", customerId: "cust-1", outTradeNo: "gfa-1", status: "PENDING", paidAt: null, subscriptionId: null };
    prisma.planOrder.findUnique
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({ ...pending, status: "PAID", paidAt: new Date(), subscriptionId: "sub-1" });
    vi.spyOn(service, "queryAndSyncEpayOrder").mockResolvedValue(true);

    const res = await service.cancelOrder("cust-1", "gfa-1");

    expect(prisma.planOrder.updateMany).not.toHaveBeenCalled(); // 已支付 → 不取消
    expect(res.status).toBe("PAID");
    expect(res.subscriptionId).toBe("sub-1");
  });

  it("非 PENDING(如 PAID)→ 幂等 no-op,原样返回,不查网关、不写库", async () => {
    const paid = { id: "o1", customerId: "cust-1", outTradeNo: "gfa-1", status: "PAID", paidAt: new Date(), subscriptionId: "sub-1" };
    prisma.planOrder.findUnique.mockResolvedValue(paid);
    const syncSpy = vi.spyOn(service, "queryAndSyncEpayOrder").mockResolvedValue(false);

    const res = await service.cancelOrder("cust-1", "gfa-1");

    expect(syncSpy).not.toHaveBeenCalled();
    expect(prisma.planOrder.updateMany).not.toHaveBeenCalled();
    expect(res.status).toBe("PAID");
  });

  it("订单不存在 / 非本人 → NotFoundException", async () => {
    prisma.planOrder.findUnique.mockResolvedValueOnce(null);
    await expect(service.cancelOrder("cust-1", "nope")).rejects.toThrow(NotFoundException);

    prisma.planOrder.findUnique.mockResolvedValueOnce({ id: "o1", customerId: "other", outTradeNo: "gfa-1", status: "PENDING" });
    await expect(service.cancelOrder("cust-1", "gfa-1")).rejects.toThrow(NotFoundException);
  });
});

// 网关退款(两步,商户私钥 RSA 签名):① POST /api/pay/refund 发起(code=0 仅受理);
// ② POST /api/pay/refundquery 复核,**必须 status=1 才算最终成功(ok)**。调用方据 ok 翻状态 ——
// 钱→状态,绝不反过来。
describe("BillingService.refundEpayOrder", () => {
  let service: BillingService;

  beforeEach(() => {
    vi.stubEnv("EPAY_PID", "1001");
    vi.stubEnv("EPAY_MERCHANT_PRIVATE_KEY", TEST_PRIV_B64);
    service = new BillingService(makeMockPrisma(), makeCatalog(), makeRosetta(), {} as any, {} as any);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** 按 URL 路由 refund / refundquery 的两步 mock。query 省略 → 不应被调用(refund 已失败)。 */
  function stubEpayFlow(responses: { refund: any; query?: any }) {
    const fetchMock = vi.fn(async (url: unknown, _init?: unknown) => ({
      json: async () =>
        String(url).endsWith("/api/pay/refundquery") ? responses.query : responses.refund,
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const callsTo = (m: any, suffix: string) =>
    m.mock.calls.filter((c: any[]) => String(c[0]).endsWith(suffix));
  const bodyOf = (call: any[]) => new URLSearchParams((call[1] as any).body as string);

  it("refund code=0 且 refundquery status=1 → ok;两步参数正确", async () => {
    const fetchMock = stubEpayFlow({ refund: { code: 0 }, query: { code: 0, status: 1, msg: "退款成功" } });

    const res = await service.refundEpayOrder("gfa-1", 9900);

    expect(res.ok).toBe(true);
    // ① 退款请求:out_trade_no / money(全额) / out_refund_no / 签名。
    const refund = bodyOf(callsTo(fetchMock, "/api/pay/refund")[0]);
    expect(refund.get("out_trade_no")).toBe("gfa-1");
    expect(refund.get("money")).toBe("99.00");
    expect(refund.get("out_refund_no")).toBe("rfgfa-1");
    expect(refund.get("sign_type")).toBe("RSA");
    expect(refund.get("sign")).toBeTruthy();
    // ② 复核请求:按同一 out_refund_no 查(不带 money)。
    const query = bodyOf(callsTo(fetchMock, "/api/pay/refundquery")[0]);
    expect(query.get("out_refund_no")).toBe("rfgfa-1");
    expect(query.get("sign")).toBeTruthy();
  });

  it("refund code=0 但 refundquery status≠1 → ok:false(只受理未确认,不翻状态)", async () => {
    stubEpayFlow({ refund: { code: 0 }, query: { code: 0, status: 0, msg: "退款处理中" } });
    const res = await service.refundEpayOrder("gfa-1", 9900);
    expect(res.ok).toBe(false);
    expect(res.msg).toContain("未确认成功");
  });

  it("refund code!=0 → ok:false 且不发起复核(refundquery 不应被调用)", async () => {
    const fetchMock = stubEpayFlow({ refund: { code: 1, msg: "订单不存在" } });
    const res = await service.refundEpayOrder("gfa-1", 9900);
    expect(res.ok).toBe(false);
    expect(res.msg).toContain("订单不存在");
    expect(callsTo(fetchMock, "/api/pay/refundquery")).toHaveLength(0);
  });

  it("退款单号 out_refund_no 确定性派生:重试用同一个号(网关去重幂等)", async () => {
    const fetchMock = stubEpayFlow({ refund: { code: 0 }, query: { code: 0, status: 1 } });
    await service.refundEpayOrder("gfa-xyz", 100);
    await service.refundEpayOrder("gfa-xyz", 100); // 重试
    const refundCalls = callsTo(fetchMock, "/api/pay/refund");
    expect(bodyOf(refundCalls[0]).get("out_refund_no")).toBe("rfgfa-xyz");
    expect(bodyOf(refundCalls[1]).get("out_refund_no")).toBe("rfgfa-xyz");
  });

  it("pid/私钥缺失 → ok:false,根本不发请求", async () => {
    vi.stubEnv("EPAY_PID", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await service.refundEpayOrder("gfa-1", 9900);
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refund 网络异常 → ok:false(吞掉异常,不抛)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const res = await service.refundEpayOrder("gfa-1", 9900);
    expect(res.ok).toBe(false);
  });

  it("refund 成功但复核请求异常 → ok:false(退款已提交但未确认)", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/api/pay/refundquery")) throw new Error("timeout");
      return { json: async () => ({ code: 0 }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await service.refundEpayOrder("gfa-1", 9900);
    expect(res.ok).toBe(false);
    expect(res.msg).toContain("复核"); // 「退款已提交,但退款查询请求失败,请稍后复核」
  });
});
