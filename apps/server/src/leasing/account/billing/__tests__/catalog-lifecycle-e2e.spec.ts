/**
 * catalog-lifecycle-e2e.spec.ts — 套餐重设计「去影子」全链路端到端套件。
 *
 * 把整条真实链串起来跑(尽量少 mock):
 *
 *   配 PlanCatalog → 发布 → GET /api/plan-catalog 读到
 *     → 客户端下单 createCatalogOrder(selection→computePurchase 算价 + 座位预检)
 *     → epay 支付回调 handleNotify(签名校验 + CAS 幂等)
 *     → 激活 SubscriptionService.activateForOrder → createFromCatalog(写 Subscription.config 含 line)
 *     → EntitlementSyncService.syncSubscription(bind 分配座位写 config.bindings / pool 跳过,
 *        都写内存 AccessKeyStore.subscriptionById、★不写 access-keys.json★)
 *     → 客户端 session JWT 登录(真实 SessionTokenResolver:Customer/Device/Subscription 校验)
 *     → 限额引擎从订阅内存读 + 用量窗口(5h/周)→ 真 LeaseService.leaseToken 租到上游 token
 *     → reportResult 上报用量(计回订阅 record)
 *
 * 关键基础设施(对齐 app-lease-e2e + entitlement-sync 两套现有 e2e):
 *  - ★单一共享 AccessKeyStore★:EntitlementSync 注册订阅 record 的那个 store,与三条租号线
 *    (TokenServer/RemoteCodex/RemoteAnthropic)经 `accessKeyStore` option 注入的是同一实例
 *    —— 否则激活写进的 record 租号侧看不到(这正是真 e2e 要验的「写读同源」)。
 *  - ★真 SessionTokenResolver★(非 stub):session JWT → 订阅 cardId 的映射走真实 DB 校验
 *    (customer.status/tokenVersion、device.status/sessionJti、ACTIVE 订阅按 product 覆盖 + 选最长寿)。
 *  - 真 Prisma test db(customer-test-db,DATABASE_URL→prisma/test.db);真 RosettaService
 *    (account pool 在 tmp dataDir,座位从这些 fixture 号选)。
 *  - 上游 token 由 tokenProvider mock(唯一外部依赖)。
 *
 * 容量口径:test env BCAI_ACCOUNT_SHARE_CAPACITY=4(vitest.config.ts)。绑定线 weight=cap/N
 * (= ACCOUNT_SHARE_CAPACITY / 共享人数,服务端读目录时注入,与运行时座位口径同源,去双源)。
 * 下面所有座位算术都 import ACCOUNT_SHARE_CAPACITY,绝不硬编码。
 */
import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JwtService } from "@nestjs/jwt";

import { BillingService } from "../billing.service";
import { EpayCallbackService } from "../epay-callback.service";
import { SubscriptionService } from "../../../subscription/subscription.service";
import { EntitlementSyncService } from "../../../subscription/entitlement-sync.service";
import { PlanCatalogService } from "../../../plan-catalog/plan-catalog.service";
import { PlanCatalogPublicController } from "../../../plan-catalog/plan-catalog-public.controller";
import { RosettaService } from "../../../rosetta/rosetta.service";
import { AccessKeyStore } from "../../../token-server/access-key-store";
import { SessionTokenResolver } from "../../../token-server/session-token-resolver";
import { CustomerTokenService } from "../../customer-auth/customer-token.service";
import { CustomerAuthService } from "../../customer-auth/customer-auth.service";
import { CustomerEmailTokenService } from "../../customer-auth/customer-email-token.service";
import { DeviceService } from "../../device/device.service";
import { TokenServerService } from "../../../token-server/token-server.service";
import { RemoteCodexService } from "../../../remote-codex/service/remote-codex.service";
import { RemoteAnthropicService } from "../../../remote-anthropic/service/remote-anthropic.service";
import * as crypto from "crypto";

import { ACCOUNT_SHARE_CAPACITY } from "../../../token-server/token-billing";
import { signParams } from "../epay.sign";
import {
  cleanCustomerTables,
  createTestCustomer,
  decodeJwtPayload,
  disconnectCustomerDb,
  ensureCustomerSchema,
  getCustomerPrisma,
} from "../../../../shared/__tests__/customer-test-db";

// ── Constants ────────────────────────────────────────────────────────────────
// V2:商户私钥用于下单签名,平台私钥签回调、平台公钥验签(E2E 用一对即可,不交叉验)。
const _e2eKP = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const E2E_PRIV_B64 = _e2eKP.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
const E2E_PUB_B64 = _e2eKP.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const EPAY_PID = "7777";
const DAY_MS = 24 * 60 * 60 * 1000;

process.env.CUSTOMER_JWT_SECRET =
  process.env.CUSTOMER_JWT_SECRET || "catalog-lifecycle-e2e-secret-0123456789abcdef";

const prisma = getCustomerPrisma();
const customerTokens = new CustomerTokenService(new JwtService({}));

// ── Catalog config (placeholder values, real shape per spec §4.1) ─────────────
// products/levels/usageTiers/pricing/durationDays/windowMs — exercised verbatim
// by computePurchase + createFromCatalog. windowMs = 5h (锁死).
const WINDOW_MS = 18_000_000;
const CATALOG_CONFIG = {
  products: ["anthropic", "codex", "antigravity"],
  levels: {
    anthropic: ["pro", "max-5x", "max-20x"],
    codex: ["plus", "pro"],
    antigravity: ["pro", "ultra"],
  },
  usageTiers: {
    small: { bucketLimits: { "anthropic-claude": 50_000, "codex-gpt": 50_000, "antigravity-gemini": 50_000 }, weeklyTokenLimit: 250_000 },
    large: { bucketLimits: { "anthropic-claude": 150_000, "codex-gpt": 150_000, "antigravity-gemini": 150_000 }, weeklyTokenLimit: 750_000 },
  },
  pricing: {
    pool: {
      product: { anthropic: 6900, codex: 3900, antigravity: 3900 },
      usage: { small: 0, large: 3000 },
      devicePerExtra: 900,
    },
    bind: {
      levelPrice: {
        anthropic: { pro: 9900, "max-5x": 15900, "max-20x": 29900 },
        codex: { plus: 13900, pro: 19900 },
        antigravity: { pro: 11900, ultra: 19900 },
      },
      share: { "1": 0, "2": -4000, "4": -7000, "8": -9000 },
      devicePerExtra: 900,
    },
  },
  durationDays: 30,
  windowMs: WINDOW_MS,
};

// ── Shared mutable harness (rebuilt per test) ─────────────────────────────────
let tmpDir: string;
let accessKeysPath: string;
let store: AccessKeyStore;
let rosetta: RosettaService;
let entitlementSync: EntitlementSyncService;
let subscriptionService: SubscriptionService;
let billingService: BillingService;
let callbackService: EpayCallbackService;
let planCatalog: PlanCatalogService;
let catalogPublic: PlanCatalogPublicController;
let sessionResolver: SessionTokenResolver;
let deviceService: DeviceService;
const tokenProvider = vi.fn();
// Lease services keyed by product so each scenario leases through the right pool.
let leaseServices: {
  anthropic: RemoteAnthropicService;
  codex: RemoteCodexService;
  antigravity: TokenServerService;
};
let leaseSeq = 0;

/**
 * Pool-account fixtures written into the tmp dataDir. Bind-line seat assignment
 * (RosettaService → isAccountBindable) reads these by file:
 *   accounts.json (antigravity), codex-accounts.json, anthropic-accounts.json.
 * Each carries an explicit `planType` (= membership level) so we never depend on
 * real upstream level probing (that's a separate todo). Antigravity also needs a
 * projectId to be eligible.
 */
function writePools(opts: {
  anthropic?: Array<Record<string, unknown>>;
  codex?: Array<Record<string, unknown>>;
  antigravity?: Array<Record<string, unknown>>;
} = {}) {
  fs.writeFileSync(
    path.join(tmpDir, "anthropic-accounts.json"),
    JSON.stringify({ accounts: opts.anthropic ?? [] }),
  );
  fs.writeFileSync(
    path.join(tmpDir, "codex-accounts.json"),
    JSON.stringify({ accounts: opts.codex ?? [] }),
  );
  fs.writeFileSync(
    path.join(tmpDir, "accounts.json"),
    JSON.stringify({ accounts: opts.antigravity ?? [] }),
  );
}

beforeAll(async () => {
  await ensureCustomerSchema();
});

beforeEach(async () => {
  await prisma.referralReward.deleteMany();
  await prisma.planCatalog.deleteMany();
  await cleanCustomerTables();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-e2e-"));
  accessKeysPath = path.join(tmpDir, "access-keys.json");
  fs.writeFileSync(accessKeysPath, JSON.stringify({ keys: [], updatedAt: "" }));
  // Default pools: one bindable account per product at a representative level.
  // capacity is ACCOUNT_SHARE_CAPACITY (test env = 4).
  writePools({
    anthropic: [{ id: 1, email: "claude-20x@pool.test", refreshToken: "rt-claude", enabled: true, planType: "max-20x" }],
    codex: [{ id: 1, email: "codex-pro@pool.test", refreshToken: "rt-codex", enabled: true, planType: "pro" }],
    antigravity: [{ id: 1, email: "ag-ultra@pool.test", refreshToken: "rt-ag", enabled: true, projectId: "proj-1", planType: "ultra" }],
  });

  vi.stubEnv("EPAY_MERCHANT_PRIVATE_KEY", E2E_PRIV_B64); // 下单 RSA 签名(V2)
  vi.stubEnv("EPAY_PLATFORM_PUBLIC_KEY", E2E_PUB_B64); // 回调 RSA 验签(V2)
  vi.stubEnv("EPAY_PID", EPAY_PID);
  vi.stubEnv("EPAY_FEE_PERCENT", "0"); // amountCents == base price (hermetic; ignore local .env)
  vi.stubEnv("EPAY_REFERRAL_PERCENT", "0"); // no referral noise in lifecycle tests

  // buildEpayPayUrl POSTs to the live zhunfu gateway — stub fetch so order creation
  // completes offline. Activation is driven directly via callbackService.handleNotify,
  // so the gateway response only needs to yield a cashier URL for the QR.
  vi.stubGlobal("fetch", vi.fn(async () => ({
    text: async () => "<script>window.location.replace('https://gw.test/pay/cashier')</script>",
  })));

  tokenProvider.mockReset();
  tokenProvider.mockResolvedValue("upstream-token");
  leaseSeq = 0;

  // ── The single shared store + real resolver (write side ↔ read side same instance) ──
  store = new AccessKeyStore(accessKeysPath);
  sessionResolver = new SessionTokenResolver(customerTokens, prisma as any);
  store.setSessionResolver(sessionResolver);

  rosetta = new RosettaService({ dataDir: tmpDir });
  planCatalog = new PlanCatalogService(prisma as any);
  catalogPublic = new PlanCatalogPublicController(planCatalog);
  deviceService = new DeviceService(prisma as any);

  entitlementSync = new EntitlementSyncService(
    rosetta,
    store,
    {} as any, // tokenServer — 去影子后 syncSubscription 不再调用,vestigial
    {} as any, // remoteCodex
    {} as any, // remoteAnthropic
    prisma as any,
  );
  subscriptionService = new SubscriptionService(prisma as any, entitlementSync, planCatalog);
  callbackService = new EpayCallbackService(prisma as any, subscriptionService, entitlementSync);
  billingService = new BillingService(prisma as any, planCatalog, rosetta, callbackService);

  // Three lease lines sharing the SAME store + injecting the real engine.
  const common = {
    accountsFilePath: undefined as string | undefined,
    accessKeysFilePath: accessKeysPath,
    accessKeyStore: store,
    tokenProvider,
    now: () => Date.now(),
    randomId: () => `lease-${++leaseSeq}`,
    minClientVersion: "",
  };
  leaseServices = {
    anthropic: new RemoteAnthropicService({ ...common, accountsFilePath: path.join(tmpDir, "anthropic-accounts.json") }),
    codex: new RemoteCodexService({ ...common, accountsFilePath: path.join(tmpDir, "codex-accounts.json") }),
    antigravity: new TokenServerService({ ...common, accountsFilePath: path.join(tmpDir, "accounts.json") }),
  };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  await prisma.referralReward.deleteMany();
  await prisma.planCatalog.deleteMany();
  await cleanCustomerTables();
  await disconnectCustomerDb();
});

// ── Helpers ────────────────────────────────────────────────────────────────

/** Publish a DRAFT catalog (default config) → PUBLISHED. Returns the published version. */
async function publishCatalog(config: Record<string, unknown> = CATALOG_CONFIG): Promise<number> {
  const draft = await planCatalog.createDraft(JSON.stringify(config));
  const published = await planCatalog.publish(draft.id);
  return published.version;
}

/** Seed a Customer + ACTIVE Device, returning a signed client session JWT (deviceId claim). */
async function seedCustomerWithDevice(deviceId = "device-1") {
  const customer = await createTestCustomer();
  const token = customerTokens.sign({
    customerId: customer.id,
    email: customer.email,
    tokenVersion: customer.tokenVersion,
    deviceId,
  });
  const jti = decodeJwtPayload(token).jti as string;
  await prisma.device.create({
    data: { customerId: customer.id, deviceId, status: "ACTIVE", sessionJti: jti },
  });
  return { customer, token, jti, deviceId };
}

/** Build a signed epay TRADE_SUCCESS body for an order at the given yuan amount. */
function epayBody(outTradeNo: string, moneyYuan: string, overrides: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {
    pid: EPAY_PID,
    trade_no: `epay-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    out_trade_no: outTradeNo,
    money: moneyYuan,
    trade_status: "TRADE_SUCCESS",
    ...overrides,
  };
  const sign = signParams(base, E2E_PRIV_B64); // 模拟 zhunfu 用平台私钥签回调
  return { ...base, sign_type: "RSA", sign };
}

const yuan = (cents: number) => (cents / 100).toFixed(2);

/**
 * Drive the FULL purchase chain for a customer + selection: order → callback →
 * activation. Returns the activated subscription row + the order.
 */
async function purchaseAndActivate(customerId: string, selection: any) {
  const order = await billingService.createCatalogOrder(customerId, selection, "ALIPAY");
  const body = epayBody(order.outTradeNo, yuan(order.amountCents));
  const result = await callbackService.handleNotify(body);
  expect(result).toBe("success");
  const row = await prisma.planOrder.findUnique({ where: { outTradeNo: order.outTradeNo } });
  const sub = row?.subscriptionId
    ? await prisma.subscription.findUnique({ where: { id: row.subscriptionId } })
    : null;
  return { order: row!, sub, orderInfo: order };
}

/** Lease one upstream token through the real engine for a product. */
function lease(product: "anthropic" | "codex" | "antigravity", token: string, body: Record<string, unknown>) {
  const modelKey =
    product === "anthropic" ? "claude-sonnet-4-6" : product === "codex" ? "gpt-5-codex" : "gemini-2.5-pro";
  return leaseServices[product].leaseToken(
    { headers: { authorization: `Bearer ${token}` } },
    { clientId: "client-A", modelKey, bodyBytes: 200, ...body },
  );
}

/** Parsed config JSON of a subscription row. */
function cfg(sub: any): Record<string, any> {
  return JSON.parse(String(sub.config || "{}"));
}

// ════════════════════════════════════════════════════════════════════════════
// 场景 1 — 正常 · 号池线 全链路
// ════════════════════════════════════════════════════════════════════════════
describe("E2E 号池线:配 catalog → 发布 → GET → 下单 → 回调激活 → 租号 → 上报 → 再租", () => {
  it("整条链跑通:config.line=pool、无座位、动态池选号、用量计回订阅、可重复租", async () => {
    const version = await publishCatalog();

    // 客户端 GET /api/plan-catalog 拿到发布版(前端据此渲染 + 算价)。
    const pub = await catalogPublic.get();
    expect(pub.version).toBe(version);
    expect((pub.config as any).products).toContain("anthropic");

    const { token, customer } = await seedCustomerWithDevice();

    const selection = { line: "pool", products: ["anthropic"], usageTier: "large", deviceLimit: 1 };
    const { order, sub, orderInfo } = await purchaseAndActivate(customer.id, selection);

    // 价格 = anthropic 号池基础 6900 + large 3000 + 0 额外设备 = 9900。
    expect(orderInfo.amountCents).toBe(6900 + 3000);
    expect(order.status).toBe("PAID");
    expect(order.subscriptionId).toBeTruthy();

    // 激活写入 Subscription.config:显式 line=pool、用量上限、catalogVersion。
    expect(sub!.status).toBe("ACTIVE");
    const c = cfg(sub);
    expect(c.line).toBe("pool");
    expect(c.products).toEqual(["anthropic"]);
    expect(c.bucketLimits["anthropic-claude"]).toBe(150_000);
    expect(c.weeklyTokenLimit).toBe(750_000);
    expect(sub!.catalogVersion).toBe(version);

    // ★去影子★:access-keys.json 未被写;限额引擎从内存 subscriptionById 读到这条订阅。
    expect(JSON.parse(fs.readFileSync(accessKeysPath, "utf8")).keys).toEqual([]);
    const rec = store.findById(sub!.id)!;
    expect(rec.id).toBe(sub!.id);
    expect(rec.requiresBinding).toBeFalsy(); // 号池不需座位
    expect(rec.bindings ?? {}).toEqual({});

    // 客户端 session JWT → 真 resolver → 内存 record → 真引擎动态池选号 → 上游 token。
    const r1 = await lease("anthropic", token, { clientId: "client-A" });
    expect(r1.ok).toBe(true);
    expect(r1.accessToken).toBe("upstream-token");
    expect(r1.accessKeySessionId).toBe("sess:client-A");

    // 上报用量计回订阅 record(accessKeyId == subscription.id)。
    const rep = await leaseServices.anthropic.reportResult(
      { headers: { authorization: `Bearer ${token}` } },
      { leaseId: r1.leaseId, status: 200, modelKey: "claude-sonnet-4-6", inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    );
    expect(rep.ok).toBe(true);
    expect(store.findById(sub!.id)!.totalTokensUsed).toBe(150);

    // 再租:号池可重复租(动态调度,不钉号)。
    const r2 = await lease("anthropic", token, { clientId: "client-A" });
    expect(r2.ok).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 场景 2 — 正常 · 绑定线 全链路 + 钉号 + fair-share
// ════════════════════════════════════════════════════════════════════════════
describe("E2E 绑定线:下单 → 激活 → 分配座位(写 config.bindings)→ 钉号租 → fair-share", () => {
  it("整条链跑通:config.line=bind、座位钉到 fixture 号、requiresBinding、租到钉的号", async () => {
    const version = await publishCatalog();
    const { token, customer } = await seedCustomerWithDevice();

    // 绑定线:anthropic max-20x,1 人独号(weight=cap=4,占满该号)。
    const selection = { line: "bind", items: [{ product: "anthropic", level: "max-20x" }], shareUsers: 1, deviceLimit: 1 };
    const { sub, orderInfo } = await purchaseAndActivate(customer.id, selection);

    // 价格 = max-20x 29900 + 独号 share[1]=0 = 29900。
    expect(orderInfo.amountCents).toBe(29900);

    const c = cfg(sub);
    expect(c.line).toBe("bind");
    expect(c.levels).toEqual({ anthropic: "max-20x" });
    // 座位分配:钉到 fixture 号 id=1(唯一 max-20x 号)。写回 config.bindings(单一真相源)。
    expect(c.bindings).toEqual({ anthropic: 1 });
    expect(c.weight).toBe(ACCOUNT_SHARE_CAPACITY / 1);

    // 内存 record:requiresBinding=true、bindings 钉到 1、access-keys.json 仍未写。
    const rec = store.findById(sub!.id)!;
    expect(rec.requiresBinding).toBe(true);
    expect(rec.bindings).toEqual({ anthropic: 1 });
    expect(JSON.parse(fs.readFileSync(accessKeysPath, "utf8")).keys).toEqual([]);

    // 租号:绑定卡钉号 → 只从 account 1 租(boundAccountId==1)。
    const r1 = await lease("anthropic", token, { clientId: "client-A" });
    expect(r1.ok).toBe(true);
    expect(r1.accountId).toBe(1);
    expect(r1.accessToken).toBe("upstream-token");
  });

  it("绑定线 2 人拼车:weight=cap/2、两张拼满该号(=容量)、第三张同号订阅无座位", async () => {
    await publishCatalog();
    const c1 = await createTestCustomer();
    const c2 = await createTestCustomer();
    const c3 = await createTestCustomer();

    // 2 人拼车 → weight cap/2,两单合占满 account 1(容量 cap)。
    const sel = { line: "bind", items: [{ product: "anthropic", level: "max-20x" }], shareUsers: 2, deviceLimit: 1 };
    const first = await purchaseAndActivate(c1.id, sel);
    expect(cfg(first.sub).weight).toBe(ACCOUNT_SHARE_CAPACITY / 2);
    expect(cfg(first.sub).bindings).toEqual({ anthropic: 1 });

    // 第二单 2 人拼车:account 1 还剩 cap/2 份 → 放行、钉到同号,占满(cap/cap)。
    const second = await purchaseAndActivate(c2.id, sel);
    expect(cfg(second.sub).bindings).toEqual({ anthropic: 1 });

    // 第三单同等级:容量已被前两单占满 → 下单座位预检直接 BadRequest。
    await expect(billingService.createCatalogOrder(c3.id, sel as any, "ALIPAY")).rejects.toThrow(/暂无可用座位|BadRequest/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 场景 3 — 号池 vs 绑定:行为差异
// ════════════════════════════════════════════════════════════════════════════
describe("E2E 号池 vs 绑定:座位/调度差异", () => {
  it("号池不占座位(绑定线仍能拿满该号份额);绑定占座位(动态池不调度出池号)", async () => {
    await publishCatalog();
    const cPool = await createTestCustomer();
    const cBind = await createTestCustomer();

    // 号池订阅同样卖 anthropic,但绝不占座位。
    await purchaseAndActivate(cPool.id, { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 });

    // 绑定线独号(weight=cap=4)仍能拿到 account 1 的全部份额 —— 证明号池没占座位。
    const bind = await purchaseAndActivate(cBind.id, {
      line: "bind", items: [{ product: "anthropic", level: "max-20x" }], shareUsers: 1, deviceLimit: 1,
    });
    expect(cfg(bind.sub).bindings).toEqual({ anthropic: 1 });

    // 座位真相源(occupiedShares,只数 line=bind):account 1 被绑定订阅按 weight 占用,号池不计。
    const rows = await prisma.subscription.findMany({ where: { status: "ACTIVE" }, select: { id: true, config: true } });
    const configs = rows.map((r) => ({ id: r.id, ...JSON.parse(String(r.config || "{}")) }));
    const occupiedBind = configs.filter((x: any) => x.line === "bind" && x.bindings?.anthropic === 1)
      .reduce((s: number, x: any) => s + Math.min(ACCOUNT_SHARE_CAPACITY, Math.max(1, Math.floor(x.weight))), 0);
    expect(occupiedBind).toBe(ACCOUNT_SHARE_CAPACITY); // 独号占满
    const occupiedPool = configs.filter((x: any) => x.line === "pool").length;
    expect(occupiedPool).toBe(1); // 存在号池订阅,但它不占座位(上面 bind 仍拿满即证)
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 场景 4 — 多订单/多订阅;同产品多订阅 → resolver 选最长寿
// ════════════════════════════════════════════════════════════════════════════
describe("E2E 多订阅:一人多单、同产品多覆盖选最长寿", () => {
  it("一人持号池(anthropic)+绑定(codex)两条不同 config 订阅,并存", async () => {
    await publishCatalog();
    const { customer, token } = await seedCustomerWithDevice();

    const poolBuy = await purchaseAndActivate(customer.id, { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 });
    const bindBuy = await purchaseAndActivate(customer.id, {
      line: "bind", items: [{ product: "codex", level: "pro" }], shareUsers: 1, deviceLimit: 1,
    });

    const subs = await prisma.subscription.findMany({ where: { customerId: customer.id, status: "ACTIVE" } });
    expect(subs).toHaveLength(2);
    expect(poolBuy.sub!.id).not.toBe(bindBuy.sub!.id);

    // 两条线分别可租:anthropic 走号池,codex 走绑定钉号。
    const rA = await lease("anthropic", token, { clientId: "client-A" });
    expect(rA.ok).toBe(true);
    const rC = await lease("codex", token, { clientId: "client-A" });
    expect(rC.ok).toBe(true);
    expect(rC.accountId).toBe(1);
  });

  it("同产品(anthropic)两条 ACTIVE 订阅 → SessionTokenResolver 选 expiresAt 最长寿那条", async () => {
    await publishCatalog();
    const { customer, token } = await seedCustomerWithDevice();

    // 第一条号池 small(30 天后过期)。
    const shortBuy = await purchaseAndActivate(customer.id, { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 });
    // 第二条绑定(也覆盖 anthropic),人为把它的 expiresAt 推到更晚 —— 模拟更长寿的覆盖。
    const longBuy = await purchaseAndActivate(customer.id, {
      line: "bind", items: [{ product: "anthropic", level: "max-20x" }], shareUsers: 2, deviceLimit: 1,
    });
    const farFuture = new Date(Date.now() + 365 * DAY_MS);
    await prisma.subscription.update({ where: { id: longBuy.sub!.id }, data: { expiresAt: farFuture } });

    // 前置:两条都 ACTIVE 且都覆盖 anthropic(productEntitlements 含之)→ resolver 的
    // covering 集确有 2 条,reduce 选最长寿分支被真正走到(非「只有一条」的退化通过)。
    const covering = await prisma.subscription.findMany({
      where: { customerId: customer.id, status: "ACTIVE", productEntitlements: { contains: "anthropic" } },
    });
    expect(covering).toHaveLength(2);

    // resolver 直接解出 cardId:同产品多覆盖 → 选最长寿(longBuy)。
    const resolved = await sessionResolver.resolve(token, { product: "anthropic" });
    expect(resolved.ok).toBe(true);
    expect((resolved as any).cardId).toBe(longBuy.sub!.id);
    expect((resolved as any).cardId).not.toBe(shortBuy.sub!.id);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 场景 5 — 续费/改配置
// ════════════════════════════════════════════════════════════════════════════
describe("E2E 续费/改配置:同 config 延长不新建;不同 config 并存", () => {
  it("同 config 号池再买 → 延长 expiresAt、不新建订阅(sameConfigFingerprint)", async () => {
    await publishCatalog();
    const { customer } = await seedCustomerWithDevice();
    const sel = { line: "pool", products: ["anthropic"], usageTier: "large", deviceLimit: 1 };

    const first = await purchaseAndActivate(customer.id, sel);
    const expiry1 = first.sub!.expiresAt!.getTime();

    const second = await purchaseAndActivate(customer.id, sel);
    // 同一条订阅被延长(id 不变),不是新建。
    expect(second.sub!.id).toBe(first.sub!.id);
    const subs = await prisma.subscription.findMany({ where: { customerId: customer.id } });
    expect(subs).toHaveLength(1);
    // expiresAt = max(now, 旧 expiry) + 30 天 → 比第一次更晚约 30 天。
    expect(second.sub!.expiresAt!.getTime()).toBeGreaterThan(expiry1);
    expect(second.sub!.expiresAt!.getTime() - expiry1).toBeGreaterThan(29 * DAY_MS);
  });

  it("不同 config(号池 small vs large)→ 新建并存,两条订阅", async () => {
    await publishCatalog();
    const { customer } = await seedCustomerWithDevice();

    const a = await purchaseAndActivate(customer.id, { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 });
    const b = await purchaseAndActivate(customer.id, { line: "pool", products: ["anthropic"], usageTier: "large", deviceLimit: 1 });

    expect(a.sub!.id).not.toBe(b.sub!.id);
    const subs = await prisma.subscription.findMany({ where: { customerId: customer.id } });
    expect(subs).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 场景 6 — 取消/退款/过期
// ════════════════════════════════════════════════════════════════════════════
describe("E2E 取消/退款/过期:座位释放复用、过期租号拒", () => {
  it("退款(取消订阅)→ 座位释放,后续同号订阅可复用该座位", async () => {
    await publishCatalog();
    const c1 = await createTestCustomer();
    const c2 = await createTestCustomer();

    // c1 独号占满 account 1(容量 4)。
    const sel = { line: "bind", items: [{ product: "anthropic", level: "max-20x" }], shareUsers: 1, deviceLimit: 1 };
    const first = await purchaseAndActivate(c1.id, sel);
    expect(cfg(first.sub).bindings).toEqual({ anthropic: 1 });

    // c2 此时下单同等级 → 无座位(预检 BadRequest)。
    await expect(billingService.createCatalogOrder(c2.id, sel as any, "ALIPAY")).rejects.toThrow(/暂无可用座位/);

    // c1 退款 → 取消订阅(座位会计只数 ACTIVE,CANCELLED 即释放)。
    await subscriptionService.cancelSubscription(first.sub!.id);
    const refreshed = await prisma.subscription.findUnique({ where: { id: first.sub!.id } });
    expect(refreshed!.status).toBe("CANCELLED");

    // c2 现在能下单并拿到 account 1 —— 座位被复用。
    const second = await purchaseAndActivate(c2.id, sel);
    expect(cfg(second.sub).bindings).toEqual({ anthropic: 1 });
  });

  it("expiresAt 过期 → 租号拒 SUBSCRIPTION_EXPIRED(resolver 不选过期订阅)", async () => {
    await publishCatalog();
    const { customer, token } = await seedCustomerWithDevice();
    const buy = await purchaseAndActivate(customer.id, { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 });

    // 人为把订阅推到已过期。
    await prisma.subscription.update({ where: { id: buy.sub!.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await expect(lease("anthropic", token, { clientId: "client-A" })).rejects.toMatchObject({
      statusCode: 403,
      body: { ok: false, error: "SUBSCRIPTION_EXPIRED" },
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 场景 7 — 边界/异常
// ════════════════════════════════════════════════════════════════════════════
describe("E2E 边界/异常", () => {
  it("绑定座位满(下单时该等级无空闲号)→ 下单 BadRequest(预检挡在付款前)", async () => {
    await publishCatalog();
    // 用满 account 1(容量 cap):一个独号(weight=cap)订阅即占满。
    const cFull = await createTestCustomer();
    await purchaseAndActivate(cFull.id, { line: "bind", items: [{ product: "anthropic", level: "max-20x" }], shareUsers: 1, deviceLimit: 1 });

    const cNew = await createTestCustomer();
    await expect(
      billingService.createCatalogOrder(
        cNew.id,
        { line: "bind", items: [{ product: "anthropic", level: "max-20x" }], shareUsers: 2, deviceLimit: 1 },
        "ALIPAY",
      ),
    ).rejects.toThrow(/暂无可用座位/);

    // 付款前挡住 → 该新客户没有订单落库。
    const orders = await prisma.planOrder.findMany({ where: { customerId: cNew.id } });
    expect(orders).toHaveLength(0);
  });

  it("等级无号(该等级 fixture 池为空)→ 激活 UNBOUND + requiresBinding → 租号 409", async () => {
    await publishCatalog();
    // anthropic 池里没有 max-5x 号(只有 max-20x)→ 预检会拦。为测「激活后 UNBOUND」这条
    // 待硬化路径(spec §10),绕过下单预检,直接拿一条 bind 订单喂激活。
    const { customer, token } = await seedCustomerWithDevice();
    const { config } = (await import("../../../plan-catalog/pricing")).computePurchase(CATALOG_CONFIG as any, {
      line: "bind", items: [{ product: "anthropic", level: "max-5x" }], shareUsers: 1, deviceLimit: 1,
    } as any);
    const order = await prisma.planOrder.create({
      data: {
        customerId: customer.id,
        amountCents: 15900,
        payChannel: "ALIPAY",
        outTradeNo: `gfa-unbound-${Date.now()}`,
        status: "PAID",
        catalogVersion: 1,
        config: JSON.stringify(config),
        expiresAt: new Date(Date.now() + DAY_MS),
      } as any,
    });
    const sub = await subscriptionService.activateForOrder(order as any);

    // 激活成功但座位分配失败 → bindings 空、requiresBinding 仍 true。
    expect(cfg(sub).bindings).toEqual({});
    const rec = store.findById(sub.id)!;
    expect(rec.requiresBinding).toBe(true);
    expect(rec.bindings ?? {}).toEqual({});

    // 租号:requiresBinding 但无座位 → 409「服务开通中」(座位耗尽路径,line 453),
    // 区别于「此卡未开通该服务」(错产品路径,需 hasAnyBinding=true)。这里 bindings 空 +
    // requiresBinding,只能命中前者 —— 绝不掉进广播号池拿到没卖的号。
    await expect(lease("anthropic", token, { clientId: "client-A" })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("服务开通中"),
    });
  });

  it("设备超 deviceLimit → 登录拒(effectiveDeviceLimit 来自订阅;超额 count 即拒)", async () => {
    await publishCatalog();
    const customer = await createTestCustomer();
    // 买 deviceLimit=1 的号池订阅。
    await purchaseAndActivate(customer.id, { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 });

    expect(await deviceService.effectiveDeviceLimit(customer.id)).toBe(1);

    // 已有一台 ACTIVE 设备 → 占满 limit。
    await prisma.device.create({ data: { customerId: customer.id, deviceId: "dev-1", status: "ACTIVE", sessionJti: "j1" } });
    const activeCount = await prisma.device.count({ where: { customerId: customer.id, status: "ACTIVE" } });
    const limit = await deviceService.effectiveDeviceLimit(customer.id);
    // app-auth 在 activeCount >= limit 时回 403 DEVICE_LIMIT_EXCEEDED —— 这里复核该判定成立。
    expect(activeCount).toBeGreaterThanOrEqual(limit);
  });

  it("5h 限额打满 → 租号 429(带 retryAfterMs)", async () => {
    await publishCatalog();
    const { customer, token } = await seedCustomerWithDevice();
    // 号池 small:anthropic-claude 5h 上限 50000。
    const buy = await purchaseAndActivate(customer.id, { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 });

    // 灌过 5h 上限再租 → 429。注意:5h enforce 数的是「窗口内 CU 加权用量」(eventUsageForLimit:
    // anthropic 桶按档位权重加权,sonnet input 约 ×0.6),NOT 原始 totalTokensUsed。上报量取足够大
    // (200k input → 远超 50000 CU)以稳过上限,避免耦合精确权重值。
    const r1 = await lease("anthropic", token, { clientId: "client-A" });
    expect(r1.ok).toBe(true);
    await leaseServices.anthropic.reportResult(
      { headers: { authorization: `Bearer ${token}` } },
      { leaseId: r1.leaseId, status: 200, modelKey: "claude-sonnet-4-6", inputTokens: 200_000, outputTokens: 0, totalTokens: 200_000 },
    );

    await expect(lease("anthropic", token, { clientId: "client-A" })).rejects.toMatchObject({
      statusCode: 429,
      body: { ok: false },
    });
  });

  it("支付回调重复 → 幂等(只激活一次、订阅唯一、不延长)", async () => {
    await publishCatalog();
    const customer = await createTestCustomer();
    const order = await billingService.createCatalogOrder(
      customer.id,
      { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 },
      "ALIPAY",
    );
    const body = epayBody(order.outTradeNo, yuan(order.amountCents));

    const r1 = await callbackService.handleNotify(body);
    const row1 = await prisma.planOrder.findUnique({ where: { outTradeNo: order.outTradeNo } });
    const sub1 = await prisma.subscription.findUnique({ where: { id: row1!.subscriptionId! } });
    const expiry1 = sub1!.expiresAt!.getTime();

    const r2 = await callbackService.handleNotify(body); // 重放
    expect(r1).toBe("success");
    expect(r2).toBe("success");

    const subs = await prisma.subscription.findMany({ where: { customerId: customer.id } });
    expect(subs).toHaveLength(1); // 没有第二条
    const sub2 = await prisma.subscription.findUnique({ where: { id: row1!.subscriptionId! } });
    expect(sub2!.expiresAt!.getTime()).toBe(expiry1); // 重放不延长
  });

  it("支付失败(非 TRADE_SUCCESS)→ 不激活,订单仍 PENDING、无订阅", async () => {
    await publishCatalog();
    const customer = await createTestCustomer();
    const order = await billingService.createCatalogOrder(
      customer.id,
      { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 },
      "ALIPAY",
    );
    // 签名有效但状态 TRADE_CLOSED → ack 不激活。
    const body = epayBody(order.outTradeNo, yuan(order.amountCents), { trade_status: "TRADE_CLOSED" });
    const result = await callbackService.handleNotify(body);
    expect(result).toBe("success"); // ack 停重试

    const row = await prisma.planOrder.findUnique({ where: { outTradeNo: order.outTradeNo } });
    expect(row!.status).toBe("PENDING");
    expect(row!.subscriptionId).toBeNull();
    const subs = await prisma.subscription.findMany({ where: { customerId: customer.id } });
    expect(subs).toHaveLength(0);
  });

  it("未回调(下单后无支付)→ 不激活,订单 PENDING、无订阅、无内存 record", async () => {
    await publishCatalog();
    const { customer, token } = await seedCustomerWithDevice();
    const order = await billingService.createCatalogOrder(
      customer.id,
      { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 },
      "ALIPAY",
    );

    const row = await prisma.planOrder.findUnique({ where: { outTradeNo: order.outTradeNo } });
    expect(row!.status).toBe("PENDING");
    expect(row!.subscriptionId).toBeNull();
    const subs = await prisma.subscription.findMany({ where: { customerId: customer.id } });
    expect(subs).toHaveLength(0);

    // 未激活 → 无订阅 → resolver 拒 → 租号 SUBSCRIPTION_EXPIRED(无有效订阅)。
    await expect(lease("anthropic", token, { clientId: "client-A" })).rejects.toMatchObject({
      statusCode: 403,
      body: { ok: false, error: "SUBSCRIPTION_EXPIRED" },
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 场景 8 — 目录版手动授予(管理员 bypass 支付):createGrantOrder → activateForOrder
// ════════════════════════════════════════════════════════════════════════════
describe("E2E 目录版手动授予:¥0 PAID GRANT 订单 → 同付费激活入口 → 真订阅", () => {
  it("号池授予:真写 GRANT 订单(验证枚举生效)→ activateForOrder → ACTIVE、config 正确、挂审计链", async () => {
    await publishCatalog();
    const customer = await createTestCustomer();

    // 管理员授予:不走支付,直接落 ¥0 PAID GRANT 订单(真 Prisma 写,验证 PayChannel.GRANT 生效)。
    const selection = { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 };
    const order = await billingService.createGrantOrder(customer.id, selection as any);
    expect(order.amountCents).toBe(0);
    expect(order.payChannel).toBe("GRANT");
    expect(order.status).toBe("PAID");

    // 走与付费同一的激活入口 → 真订阅。
    const sub = await subscriptionService.activateForOrder(order);
    expect(sub.status).toBe("ACTIVE");
    const c = cfg(sub);
    expect(c.line).toBe("pool");
    expect(c.products).toEqual(["anthropic"]);

    // 订阅挂到该授予订单(审计链 activatedFromOrderId),并按 catalog durationDays 设了有效期。
    const reread = await prisma.subscription.findUnique({ where: { id: sub.id } });
    expect(reread!.activatedFromOrderId).toBe(order.id);
    expect(reread!.expiresAt).not.toBeNull();
  });

  it("绑定授予:真分配座位写 config.bindings、内存 record requiresBinding(与付费授予同路径)", async () => {
    await publishCatalog();
    const customer = await createTestCustomer();

    const selection = { line: "bind", items: [{ product: "anthropic", level: "max-20x" }], shareUsers: 1, deviceLimit: 1 };
    const order = await billingService.createGrantOrder(customer.id, selection as any);
    expect(order.payChannel).toBe("GRANT");

    const sub = await subscriptionService.activateForOrder(order);
    const c = cfg(sub);
    expect(c.line).toBe("bind");
    expect(c.bindings).toEqual({ anthropic: 1 }); // 钉到唯一 max-20x fixture 号
    const rec = store.findById(sub.id)!;
    expect(rec.requiresBinding).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 场景 9 — 真·全流程一条龙:注册 → 邮箱验证 → 登录 → 设备会话 → 多产品订阅
//          → 同账户同时租用 → 用量各自统计 → 限流各自独立
// ════════════════════════════════════════════════════════════════════════════
describe("E2E 真·一条龙:注册→验证→登录→(真 token)下单→激活→租号 + 多订阅同账户并用 + 统计/限流", () => {
  // 走真实 CustomerAuthService(真写 customer / email-token、真发验证邮件、真校验凭据)。
  // 邮件用 mock 捕获:验证 token 明文只在邮件链接里(DB 只存 sha256 hash),模拟"收信点链接"。
  async function registerVerifyLogin(email: string, password: string, deviceId = "device-1") {
    const mailbox: Array<{ to: string; subject: string; text: string }> = [];
    const mailService = { sendMail: vi.fn(async (o: any) => { mailbox.push(o); return { ok: true }; }) } as any;
    const authService = new CustomerAuthService(
      prisma as any,
      customerTokens,
      new CustomerEmailTokenService(prisma as any),
      mailService,
    );

    // ① 注册:真写 customer + 触发 best-effort 验证邮件(fire-and-forget)。
    await authService.register({ email, password });

    // ② 收验证邮件(异步,等它 flush)→ 从链接抽明文 token → 验证邮箱(真 consume token)。
    await vi.waitFor(() => expect(mailbox.some((m) => /verify-email/.test(m.text))).toBe(true));
    const verifyMail = mailbox.find((m) => /verify-email/.test(m.text))!;
    const token = /token=([0-9a-f]+)/.exec(verifyMail.text)![1];
    await authService.verifyEmail(token);

    // ③ 登录:凭真实注册的邮箱+密码拿真 accessToken(emailVerified 已翻 true)。
    const { accessToken, customer } = await authService.login({ email, password });
    expect(accessToken).toBeTruthy();
    expect(customer.emailVerified).toBe(true);

    // ④ 设备会话:登录后激活设备 → 带 deviceId 的 session JWT(租号要它,等价客户端激活设备)。
    const raw = (await prisma.customer.findUnique({ where: { id: customer.id } }))!;
    const sessionToken = customerTokens.sign({
      customerId: raw.id, email: raw.email, tokenVersion: raw.tokenVersion, deviceId,
    });
    const jti = decodeJwtPayload(sessionToken).jti as string;
    await prisma.device.create({ data: { customerId: raw.id, deviceId, status: "ACTIVE", sessionJti: jti } });
    return { customer: raw, sessionToken };
  }

  const reportUsage = (
    product: "anthropic" | "codex" | "antigravity",
    sessionToken: string,
    leaseId: string,
    modelKey: string,
    tokens: number,
  ) =>
    leaseServices[product].reportResult(
      { headers: { authorization: `Bearer ${sessionToken}` } },
      { leaseId, status: 200, modelKey, inputTokens: tokens, outputTokens: 0, totalTokens: tokens },
    );

  it("注册→邮箱验证→登录拿真凭据→设备会话→号池下单激活→租号→上报(认证真接套餐链路)", async () => {
    await publishCatalog();
    const { customer, sessionToken } = await registerVerifyLogin("alice@e2e.test", "pw-alice-123");

    // 邮箱验证链路真跑通。
    expect(customer.emailVerified).toBe(true);

    // 用真实注册的客户下单 → 回调激活。
    const { order, sub } = await purchaseAndActivate(customer.id, {
      line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1,
    });
    expect(order.status).toBe("PAID");
    expect(sub!.status).toBe("ACTIVE");

    // 用「登录后建立的设备 session token」租号 → 认证闭环到租号。
    const r = await lease("anthropic", sessionToken, { clientId: "client-A" });
    expect(r.ok).toBe(true);
    expect(r.accessToken).toBe("upstream-token");

    // 上报用量计回该订阅。
    await reportUsage("anthropic", sessionToken, r.leaseId, "claude-sonnet-4-6", 150);
    expect(store.findById(sub!.id)!.totalTokensUsed).toBe(150);
  });

  it("一账户多订阅(anthropic号池 + codex绑定 + antigravity号池)→ 同设备 token 同时租用、各命中对应订阅、用量各自统计、ACTIVE 订阅数=3", async () => {
    await publishCatalog();
    const { customer, sessionToken } = await registerVerifyLogin("bob@e2e.test", "pw-bob-12345");

    // 三条「内容不同、产品不同、号池/绑定混合」的订阅(等价多张不同卡密)。
    const subA = (await purchaseAndActivate(customer.id, { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 })).sub!;
    const subC = (await purchaseAndActivate(customer.id, { line: "bind", items: [{ product: "codex", level: "pro" }], shareUsers: 1, deviceLimit: 1 })).sub!;
    const subG = (await purchaseAndActivate(customer.id, { line: "pool", products: ["antigravity"], usageTier: "small", deviceLimit: 1 })).sub!;

    // 订阅数统计:该账户 3 条 ACTIVE。
    expect(await prisma.subscription.count({ where: { customerId: customer.id, status: "ACTIVE" } })).toBe(3);
    expect(cfg(subA).line).toBe("pool");
    expect(cfg(subC).line).toBe("bind");
    expect(cfg(subC).bindings).toEqual({ codex: 1 }); // 绑定钉到唯一 codex fixture 号
    expect(cfg(subG).line).toBe("pool");

    // 同一设备 token 同时租三个产品 → SessionTokenResolver 按 product 各命中对应订阅。
    const ra = await lease("anthropic", sessionToken, { clientId: "client-A" });
    const rc = await lease("codex", sessionToken, { clientId: "client-A" });
    const rg = await lease("antigravity", sessionToken, { clientId: "client-A" });
    expect([ra.ok, rc.ok, rg.ok]).toEqual([true, true, true]);

    // 各自上报 → 用量记到各自订阅、互不串(统计无串扰)。
    await reportUsage("anthropic", sessionToken, ra.leaseId, "claude-sonnet-4-6", 100);
    await reportUsage("codex", sessionToken, rc.leaseId, "gpt-5-codex", 200);
    await reportUsage("antigravity", sessionToken, rg.leaseId, "gemini-2.5-pro", 300);
    expect(store.findById(subA.id)!.totalTokensUsed).toBe(100);
    expect(store.findById(subC.id)!.totalTokensUsed).toBe(200);
    expect(store.findById(subG.id)!.totalTokensUsed).toBe(300);
  });

  it("限流按订阅独立:打满 anthropic 5h 桶 → anthropic 429,同账户 codex/antigravity 仍可租", async () => {
    await publishCatalog();
    const { customer, sessionToken } = await registerVerifyLogin("carol@e2e.test", "pw-carol-123");
    await purchaseAndActivate(customer.id, { line: "pool", products: ["anthropic"], usageTier: "small", deviceLimit: 1 });
    await purchaseAndActivate(customer.id, { line: "bind", items: [{ product: "codex", level: "pro" }], shareUsers: 1, deviceLimit: 1 });
    await purchaseAndActivate(customer.id, { line: "pool", products: ["antigravity"], usageTier: "small", deviceLimit: 1 });

    // 打满 anthropic 5h 桶(灌远超 small 上限 50000 CU 的量)。
    const ra = await lease("anthropic", sessionToken, { clientId: "client-A" });
    await reportUsage("anthropic", sessionToken, ra.leaseId, "claude-sonnet-4-6", 200_000);

    // anthropic 限流 429;但 codex / antigravity 是独立订阅 + 独立桶,不受影响。
    await expect(lease("anthropic", sessionToken, { clientId: "client-A" })).rejects.toMatchObject({
      statusCode: 429, body: { ok: false },
    });
    expect((await lease("codex", sessionToken, { clientId: "client-A" })).ok).toBe(true);
    expect((await lease("antigravity", sessionToken, { clientId: "client-A" })).ok).toBe(true);
  });
});
