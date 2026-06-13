/**
 * billing-integration.spec.ts — real Prisma DB tests for billing (catalog-only):
 *  - Catalog order create persists correctly with referrerId snapshot + 30m expiry
 *  - Callback happy path: PAID status, subscription activated, notification, reward
 *  - Idempotency: replay → no double-reward, both responses "success"
 *  - Subscriptions list: migratedFromKey set → migratedFromCard true
 *  - List/get: ownership scoping
 *
 * Uses the same customer-test-db.ts bootstrap as M5 subscription specs.
 * Orders go through the catalog path (createCatalogOrder + a PUBLISHED
 * PlanCatalog priced so a known selection costs 990 / 1000 cents).
 */
import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BillingService } from "../billing.service";
import { EpayCallbackService } from "../epay-callback.service";
import { SubscriptionService } from "../../../subscription/subscription.service";
import { EntitlementSyncService } from "../../../subscription/entitlement-sync.service";
import { PlanCatalogService } from "../../../plan-catalog/plan-catalog.service";
import { RosettaService } from "../../../rosetta/rosetta.service";
import * as crypto from "crypto";

import { AccessKeyStore } from "../../../token-server/access-key-store";
import { signParams } from "../epay.sign";
import {
  cleanCustomerTables,
  createTestCustomer,
  disconnectCustomerDb,
  ensureCustomerSchema,
  getCustomerPrisma,
} from "../../../../shared/__tests__/customer-test-db";

// ─── Constants ────────────────────────────────────────────────────────────────
// V2:商户私钥下单签名 + 平台私钥签回调 / 平台公钥验签(integration 用一对即可)。
const _intKP = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const INT_PRIV_B64 = _intKP.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
const INT_PUB_B64 = _intKP.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const EPAY_PID = "9001";

// Pool-line catalog priced so the default selection costs exactly 990, and the
// `large` usage tier costs 1000 — matching the legacy plan prices these tests assert.
const CATALOG_CONFIG = {
  products: ["antigravity"],
  levels: { antigravity: ["ultra"] },
  usageTiers: {
    small: { bucketLimits: { "antigravity-gemini": 1_000_000 }, weeklyTokenLimit: 5_000_000 },
    large: { bucketLimits: { "antigravity-gemini": 1_000_000 }, weeklyTokenLimit: 5_000_000 },
  },
  pricing: {
    pool: { product: { antigravity: 990 }, usage: { small: 0, large: 10 }, devicePerExtra: 900 },
    bind: { levelPrice: { antigravity: { ultra: 990 } }, share: { "1": 0 }, devicePerExtra: 900 },
  },
  durationDays: 30,
  windowMs: 18_000_000,
};

// ─── Prisma + helpers ─────────────────────────────────────────────────────────
const prisma = getCustomerPrisma();

let tmpDir: string;
let accessKeysPath: string;
let store: AccessKeyStore;
let subscriptionService: SubscriptionService;
let entitlementSync: EntitlementSyncService;
let planCatalog: PlanCatalogService;
let billingService: BillingService;
let callbackService: EpayCallbackService;

/** Publish the integration catalog (version 1) so createCatalogOrder + activation can price/resolve it. */
async function publishCatalog() {
  await prisma.planCatalog.deleteMany();
  return prisma.planCatalog.create({
    data: {
      version: 1,
      status: "PUBLISHED",
      config: JSON.stringify(CATALOG_CONFIG),
      publishedAt: new Date(),
    },
  });
}

/** A pool-line catalog order priced at 990 (small) or 1000 (large). */
function catalogOrder(
  customerId: string,
  channel: "ALIPAY" | "WXPAY",
  usageTier: "small" | "large" = "small",
) {
  return billingService.createCatalogOrder(
    customerId,
    { line: "pool", products: ["antigravity"], usageTier, deviceLimit: 1 } as any,
    channel,
  );
}

function buildBody(outTradeNo: string, money: string, overrides: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {
    pid: EPAY_PID,
    trade_no: `epay-${Date.now()}`,
    out_trade_no: outTradeNo,
    money,
    trade_status: "TRADE_SUCCESS",
    ...overrides,
  };
  const sign = signParams(base, INT_PRIV_B64);
  return { ...base, sign_type: "RSA", sign };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensureCustomerSchema();
});

beforeEach(async () => {
  // ReferralReward references Customer (referrerId/inviteeId) — clean first.
  await prisma.referralReward.deleteMany();
  await cleanCustomerTables();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "billing-int-"));
  accessKeysPath = path.join(tmpDir, "access-keys.json");
  fs.writeFileSync(accessKeysPath, JSON.stringify({ keys: [], updatedAt: "" }));
  fs.writeFileSync(path.join(tmpDir, "accounts.json"), JSON.stringify({
    accounts: [
      { id: 1, email: "ultra-1@pool.test", refreshToken: "rt", enabled: true, projectId: "p1", planType: "ultra" },
    ],
  }));

  vi.stubEnv("EPAY_MERCHANT_PRIVATE_KEY", INT_PRIV_B64);
  vi.stubEnv("EPAY_PLATFORM_PUBLIC_KEY", INT_PUB_B64);
  vi.stubEnv("EPAY_PID", EPAY_PID);
  vi.stubEnv("EPAY_REFERRAL_PERCENT", "10");
  // Pin fee to 0 so order amounts equal the base price: these tests assert base
  // prices and build callback bodies at base price. Without this, a developer's
  // local .env (EPAY_FEE_PERCENT) leaks in via Vitest and breaks every amount check.
  vi.stubEnv("EPAY_FEE_PERCENT", "0");

  // buildEpayPayUrl POSTs to the live zhunfu gateway — stub fetch so order creation
  // completes offline. The signed V2 request is asserted via the captured POST body;
  // callback activation is driven directly via callbackService.handleNotify.
  vi.stubGlobal("fetch", vi.fn(async () => ({
    text: async () => "<script>window.location.replace('https://gw.test/pay/cashier')</script>",
  })));

  const rosetta = new RosettaService({ dataDir: tmpDir });
  store = new AccessKeyStore(accessKeysPath);
  entitlementSync = new EntitlementSyncService(
    rosetta,
    store,
    { reloadAccessKeys: vi.fn(() => store.reload()) } as any,
    { reloadAccessKeys: vi.fn() } as any,
    { reloadAccessKeys: vi.fn() } as any,
    prisma as any,
  );
  planCatalog = new PlanCatalogService(prisma as any);
  subscriptionService = new SubscriptionService(prisma as any, entitlementSync, planCatalog);
  callbackService = new EpayCallbackService(prisma as any, subscriptionService, entitlementSync);
  billingService = new BillingService(prisma as any, planCatalog, rosetta, callbackService);

  await publishCatalog();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  await prisma.referralReward.deleteMany();
  await cleanCustomerTables();
  await disconnectCustomerDb();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("BillingService.createCatalogOrder — DB integration", () => {
  it("persists a PENDING order with 30m expiry and referrerId snapshot", async () => {
    const referrer = await createTestCustomer();
    const customer = await prisma.customer.create({
      data: {
        email: `buyer-${Date.now()}@test.local`,
        passwordHash: "$2b$10$test",
        referralCode: `R${Date.now()}`,
        invitedById: referrer.id,
      },
    });

    const result = await catalogOrder(customer.id, "ALIPAY");

    expect(result.outTradeNo).toMatch(/^gfa\d+[0-9a-f]{12}$/);
    expect(result.amountCents).toBe(990);
    expect(result.qrDataUri).toMatch(/^data:image\/png;base64,/);
    // V2:payUrl 是网关返回的收银台地址;签名的下单请求体里才有 money/sign_type/sign。
    expect(result.payUrl).toBe("https://gw.test/pay/cashier");
    const [submitUrl, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(submitUrl)).toContain("/api/pay/submit");
    const reqBody = new URLSearchParams((init as any).body as string);
    expect(reqBody.get("money")).toBe("9.90");
    expect(reqBody.get("sign_type")).toBe("RSA");
    expect(reqBody.get("sign")).toBeTruthy();
    expect(reqBody.get("out_trade_no")).toBe(result.outTradeNo);

    const stored = await prisma.planOrder.findUnique({ where: { outTradeNo: result.outTradeNo } });
    expect(stored).toBeTruthy();
    expect(stored!.status).toBe("PENDING");
    expect(stored!.referrerId).toBe(referrer.id); // snapshot at order-create time
    expect(stored!.amountCents).toBe(990);
    const nowMs = Date.now();
    const expiresMs = stored!.expiresAt.getTime();
    expect(expiresMs - nowMs).toBeGreaterThan(29 * 60 * 1000);
    expect(expiresMs - nowMs).toBeLessThan(31 * 60 * 1000);
  });
});

describe("EpayCallbackService — callback happy path (DB integration)", () => {
  it("marks order PAID, activates subscription, creates BILLING notification, returns 'success'", async () => {
    const customer = await createTestCustomer();
    const { outTradeNo } = await catalogOrder(customer.id, "ALIPAY");

    const body = buildBody(outTradeNo, "9.90");
    const result = await callbackService.handleNotify(body);

    expect(result).toBe("success");

    const order = await prisma.planOrder.findUnique({ where: { outTradeNo } });
    expect(order!.status).toBe("PAID");
    expect(order!.paidAt).toBeTruthy();
    expect(order!.subscriptionId).toBeTruthy();
    expect(order!.epayTradeNo).toBeTruthy();

    const notification = await prisma.notification.findFirst({
      where: { customerId: customer.id, type: "BILLING" },
    });
    expect(notification).toBeTruthy();
    expect(notification!.title).toBe("套餐已开通");

    const sub = await prisma.subscription.findUnique({ where: { id: order!.subscriptionId! } });
    expect(sub).toBeTruthy();
    expect(sub!.status).toBe("ACTIVE");
  });
});

describe("EpayCallbackService — idempotency (DB integration)", () => {
  it("replaying a PAID callback twice: order activated ONCE, ONE reward, both responses 'success'", async () => {
    const referrer = await createTestCustomer();
    const customer = await prisma.customer.create({
      data: {
        email: `buyer-idemp-${Date.now()}@test.local`,
        passwordHash: "$2b$10$test",
        referralCode: `RIDEMP${Date.now()}`,
        invitedById: referrer.id,
      },
    });
    const { outTradeNo } = await catalogOrder(customer.id, "ALIPAY");

    const body = buildBody(outTradeNo, "9.90");

    // First callback
    const r1 = await callbackService.handleNotify(body);
    expect(r1).toBe("success");

    // Capture subscription expiry after the first activation.
    const order1 = await prisma.planOrder.findUnique({ where: { outTradeNo } });
    const subAfterFirst = await prisma.subscription.findUnique({ where: { id: order1!.subscriptionId! } });
    const expiryAfterFirst = subAfterFirst!.expiresAt!.getTime();

    // Second callback (replay)
    const r2 = await callbackService.handleNotify(body);
    expect(r2).toBe("success");

    // Only one subscription
    const subCount = await prisma.subscription.count({ where: { customerId: customer.id } });
    expect(subCount).toBe(1);

    // Replay must NOT extend: expiresAt is unchanged (guards extend-on-replay regression).
    const subAfterSecond = await prisma.subscription.findUnique({ where: { id: order1!.subscriptionId! } });
    expect(subAfterSecond!.expiresAt!.getTime()).toBe(expiryAfterFirst);

    // Only one reward
    const rewards = await prisma.referralReward.findMany({
      where: { referrerId: referrer.id },
    });
    expect(rewards).toHaveLength(1);

    // Referrer creditCents incremented only once: 10% of 990 = 99
    const refreshedReferrer = await prisma.customer.findUnique({ where: { id: referrer.id } });
    expect(refreshedReferrer!.creditCents).toBe(99);
  });

  it("two CONCURRENT callbacks for one PENDING order: exactly one activation, one notification, one reward, extended once", async () => {
    const referrer = await createTestCustomer();
    const customer = await prisma.customer.create({
      data: {
        email: `buyer-concurrent-${Date.now()}@test.local`,
        passwordHash: "$2b$10$test",
        referralCode: `RCONC${Date.now()}`,
        invitedById: referrer.id,
      },
    });
    const { outTradeNo } = await catalogOrder(customer.id, "ALIPAY");

    const body = buildBody(outTradeNo, "9.90");

    // Fire two callbacks concurrently. The CAS guarantees only one wins.
    const [r1, r2] = await Promise.all([
      callbackService.handleNotify(body),
      callbackService.handleNotify(body),
    ]);
    expect(r1).toBe("success");
    expect(r2).toBe("success");

    // Exactly one subscription (no double activation = no free extra month).
    const subs = await prisma.subscription.findMany({ where: { customerId: customer.id } });
    expect(subs).toHaveLength(1);

    // Expiry extended by exactly one durationDays from now (~30 days).
    const expectedExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(subs[0].expiresAt!.getTime() - expectedExpiry)).toBeLessThan(5 * 60 * 1000);

    // Exactly one BILLING notification.
    const notifs = await prisma.notification.findMany({ where: { customerId: customer.id, type: "BILLING" } });
    expect(notifs).toHaveLength(1);

    // Exactly one reward; referrer credited once.
    const rewards = await prisma.referralReward.findMany({ where: { referrerId: referrer.id } });
    expect(rewards).toHaveLength(1);
    const refreshedReferrer = await prisma.customer.findUnique({ where: { id: referrer.id } });
    expect(refreshedReferrer!.creditCents).toBe(99);

    // Order is PAID and linked.
    const order = await prisma.planOrder.findUnique({ where: { outTradeNo } });
    expect(order!.status).toBe("PAID");
    expect(order!.subscriptionId).toBe(subs[0].id);
  });
});

describe("EpayCallbackService — referral (DB integration)", () => {
  it("creates ReferralReward with correct amountCents and increments referrer creditCents", async () => {
    const referrer = await createTestCustomer();
    const customer = await prisma.customer.create({
      data: {
        email: `buyer-ref-${Date.now()}@test.local`,
        passwordHash: "$2b$10$test",
        referralCode: `RREF${Date.now()}`,
        invitedById: referrer.id,
      },
    });
    // `large` usage tier prices to 1000 cents (990 + 10).
    const { outTradeNo } = await catalogOrder(customer.id, "WXPAY", "large");

    const body = buildBody(outTradeNo, "10.00");
    await callbackService.handleNotify(body);

    const reward = await prisma.referralReward.findFirst({
      where: { referrerId: referrer.id, inviteeId: customer.id },
    });
    expect(reward).toBeTruthy();
    expect(reward!.amountCents).toBe(100); // 10% of 1000

    const refreshed = await prisma.customer.findUnique({ where: { id: referrer.id } });
    expect(refreshed!.creditCents).toBe(100);
  });

  it("no ReferralReward when order has no referrerId", async () => {
    const customer = await createTestCustomer(); // invitedById = null
    const { outTradeNo } = await catalogOrder(customer.id, "ALIPAY");

    const body = buildBody(outTradeNo, "9.90");
    await callbackService.handleNotify(body);

    const rewards = await prisma.referralReward.findMany({});
    expect(rewards).toHaveLength(0);
  });
});

describe("EpayCallbackService — security failures (DB integration)", () => {
  it("tampered sign: returns 'fail', no state change", async () => {
    const customer = await createTestCustomer();
    const { outTradeNo } = await catalogOrder(customer.id, "ALIPAY");

    const tampered = buildBody(outTradeNo, "9.90");
    tampered.sign = "00000000000000000000000000000000";

    const result = await callbackService.handleNotify(tampered);
    expect(result).toBe("fail");

    const order = await prisma.planOrder.findUnique({ where: { outTradeNo } });
    expect(order!.status).toBe("PENDING"); // unchanged
  });

  it("wrong pid: returns 'fail'", async () => {
    const customer = await createTestCustomer();
    const { outTradeNo } = await catalogOrder(customer.id, "ALIPAY");

    const base: Record<string, string> = {
      pid: "WRONG_PID",
      trade_no: "epay-123",
      out_trade_no: outTradeNo,
      money: "9.90",
      trade_status: "TRADE_SUCCESS",
    };
    const body = { ...base, sign_type: "RSA", sign: signParams(base, INT_PRIV_B64) };

    const result = await callbackService.handleNotify(body);
    expect(result).toBe("fail");
  });

  it("amount mismatch: returns 'fail', no activation", async () => {
    const customer = await createTestCustomer();
    const { outTradeNo } = await catalogOrder(customer.id, "ALIPAY");

    const body = buildBody(outTradeNo, "1.00"); // 100 cents, not 990
    const result = await callbackService.handleNotify(body);
    expect(result).toBe("fail");

    const order = await prisma.planOrder.findUnique({ where: { outTradeNo } });
    expect(order!.status).toBe("PENDING");
  });

  it("unknown out_trade_no: returns 'fail'", async () => {
    const body = buildBody("gfa-nonexistent-order", "9.90");
    const result = await callbackService.handleNotify(body);
    expect(result).toBe("fail");
  });
});

describe("BillingService.listOrders + getOrder — ownership scoping (DB integration)", () => {
  it("getOrder: other customer's outTradeNo → NotFoundException", async () => {
    const cust1 = await createTestCustomer();
    const cust2 = await createTestCustomer();
    const { outTradeNo } = await catalogOrder(cust1.id, "ALIPAY");

    // cust2 tries to access cust1's order
    await expect(billingService.getOrder(cust2.id, outTradeNo)).rejects.toThrow(/not found/i);
  });

  it("listOrders: only returns current customer's orders, total correct", async () => {
    const cust1 = await createTestCustomer();
    const cust2 = await createTestCustomer();

    // Create 2 orders for cust1, 1 for cust2。
    // 不同 selection(small/large)→ 不触发「同 customer+同 selection」复用,确保是 2 笔独立订单。
    await catalogOrder(cust1.id, "ALIPAY", "small");
    await catalogOrder(cust1.id, "WXPAY", "large");
    await catalogOrder(cust2.id, "ALIPAY");

    const result = await billingService.listOrders(cust1.id, 1, 10);
    expect(result.total).toBe(2);
    expect(result.orders).toHaveLength(2);
    result.orders.forEach((o) => {
      // all belong to cust1 (we can verify by checking they're not cust2's)
      expect(o.outTradeNo).toBeTruthy();
    });
  });

  it("pagination: page 2 with pageSize 1 returns the older order", async () => {
    const customer = await createTestCustomer();
    // 不同 selection → 避免同 selection 复用,确保 2 笔独立订单(才能测分页)。
    await catalogOrder(customer.id, "ALIPAY", "small");
    await catalogOrder(customer.id, "WXPAY", "large");

    const page1 = await billingService.listOrders(customer.id, 1, 1);
    const page2 = await billingService.listOrders(customer.id, 2, 1);

    expect(page1.total).toBe(2);
    expect(page1.orders).toHaveLength(1);
    expect(page2.orders).toHaveLength(1);
    // Different orders
    expect(page1.orders[0].outTradeNo).not.toBe(page2.orders[0].outTradeNo);
  });
});

describe("BillingService.listSubscriptions — DB integration", () => {
  it("migratedFromKey set → planName null + migratedFromCard true + products parsed", async () => {
    const customer = await createTestCustomer();

    // Create a card-migrated subscription (provenance marker set).
    await prisma.subscription.create({
      data: {
        id: "card-mig-billing-test",
        customerId: customer.id,
        migratedFromKey: "BCAI-MIG-TEST",
        status: "ACTIVE",
        productEntitlements: JSON.stringify(["antigravity", "codex"]),
        backingKeyValue: "sub_" + "c".repeat(48),
        expiresAt: null,
      },
    });

    const result = await billingService.listSubscriptions(customer.id);
    expect(result.subscriptions).toHaveLength(1);
    const sub = result.subscriptions[0];
    expect(sub.planName).toBeNull();
    expect(sub.migratedFromCard).toBe(true);
    expect(sub.products).toEqual(["antigravity", "codex"]);
    expect(sub.expiresAt).toBeNull();
  });

  it("catalog purchase → planName = products joined + migratedFromCard false", async () => {
    const customer = await createTestCustomer();
    const { outTradeNo } = await catalogOrder(customer.id, "ALIPAY");
    const body = buildBody(outTradeNo, "9.90");
    await callbackService.handleNotify(body);

    const result = await billingService.listSubscriptions(customer.id);
    expect(result.subscriptions).toHaveLength(1);
    const sub = result.subscriptions[0];
    // 目录订阅用 products 拼接作展示名(只有迁移卡密订阅才 planName=null → 前端回退「迁移卡密订阅」)。
    expect(sub.planName).toBe("antigravity");
    expect(sub.migratedFromCard).toBe(false);
  });
});
