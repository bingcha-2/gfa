import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AccessKeyStore } from "../../token-server/access-key-store";
import { PlanCatalogService } from "../../plan-catalog/plan-catalog.service";
import { RosettaService } from "../../rosetta/rosetta.service";
import { EntitlementSyncService } from "../../subscription/entitlement-sync.service";
import { SubscriptionService } from "../../subscription/subscription.service";
import {
  cleanCustomerTables,
  createTestCustomer,
  disconnectCustomerDb,
  ensureCustomerSchema,
  getCustomerPrisma,
} from "../../../shared/__tests__/customer-test-db";
import { TrialService } from "../trial.service";

const prisma = getCustomerPrisma();
const DAY_MS = 24 * 60 * 60 * 1000;

let tmpDir: string;
let trialService: TrialService;
let store: AccessKeyStore;

beforeAll(async () => {
  await ensureCustomerSchema();
});

beforeEach(async () => {
  await cleanCustomerTables();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trial-svc-"));
  const accessKeysPath = path.join(tmpDir, "access-keys.json");
  fs.writeFileSync(accessKeysPath, JSON.stringify({ keys: [], updatedAt: "" }));
  fs.writeFileSync(path.join(tmpDir, "accounts.json"), JSON.stringify({ accounts: [] }));

  await prisma.planCatalog.deleteMany();
  await prisma.planCatalog.create({
    data: {
      version: 1,
      status: "PUBLISHED",
      config: JSON.stringify({
        products: ["codex", "anthropic"],
        levels: {},
        usageTiers: {
          small: {
            bucketLimits: { "anthropic-claude": 50_000 },
            weeklyTokenLimit: 250_000,
          },
        },
        pricing: {
          pool: {
            product: { codex: 3900, anthropic: 6900 },
            usage: { small: 0 },
            devicePerExtra: 900,
          },
          bind: {
            levelPrice: {},
            share: {},
            devicePerExtra: 900,
          },
        },
        durationDays: 30,
        windowMs: 18_000_000,
      }),
      publishedAt: new Date(),
    },
  });

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
  const catalog = new PlanCatalogService(prisma as any);
  const subscriptions = new SubscriptionService(prisma as any, sync, catalog);
  trialService = new TrialService(
    prisma as any,
    catalog,
    subscriptions,
  );
});

afterEach(async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await prisma.planCatalog.deleteMany();
});

afterAll(async () => {
  await cleanCustomerTables();
  await disconnectCustomerDb();
});

describe("TrialService", () => {
  it("uses a hard-coded $20 weekly default", () => {
    expect(trialService.getDefaultWeeklyUsdLimit()).toBe(20);
  });

  it("creates a zero-value TRIAL order and a first-class trial subscription", async () => {
    const customer = await createTestCustomer();
    const before = Date.now();

    const result = await trialService.grantTrial(customer.id, {
      durationDays: 5,
      weeklyUsdLimit: 6,
    });

    expect(result.created).toBe(true);
    expect(result.subscription.isTrial).toBe(true);
    expect(result.subscription.status).toBe("ACTIVE");
    expect(result.subscription.deviceLimit).toBe(1);
    expect(JSON.parse(result.subscription.productEntitlements)).toEqual(["codex"]);
    expect(result.subscription.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 5 * DAY_MS);
    expect(result.subscription.expiresAt!.getTime()).toBeLessThan(before + 5 * DAY_MS + 60_000);
    expect(JSON.parse(result.subscription.config!)).toMatchObject({
      line: "pool",
      products: ["codex"],
      bucketLimits: {},
      weeklyTokenLimit: 0,
      quotaAlgorithm: "usd",
      usdQuotaByProduct: {
        codex: { fiveHour: 0, weekly: 6 },
      },
      windowMs: 18_000_000,
      trial: {
        durationDays: 5,
        weeklyUsdLimit: 6,
        policy: "one-per-customer",
      },
    });
    expect(store.publicStatus(store.findById(result.subscription.id)!)).toMatchObject({
      quotaMode: "usd",
      usdQuotaByProduct: {
        codex: {
          fiveHour: null,
          weekly: { used: 0, limit: 6 },
        },
      },
    });

    const order = await prisma.planOrder.findUnique({
      where: { outTradeNo: `trial_${customer.id}` },
    });
    expect(order).toMatchObject({
      payChannel: "TRIAL",
      status: "PAID",
      amountCents: 0,
      subscriptionId: result.subscription.id,
    });
  });

  it("is idempotent across retries and does not extend an existing trial", async () => {
    const customer = await createTestCustomer();
    const first = await trialService.grantTrial(customer.id, {
      durationDays: 3,
      weeklyUsdLimit: 5,
    });
    const firstExpiry = first.subscription.expiresAt!.getTime();

    const second = await trialService.grantTrial(customer.id, {
      durationDays: 30,
      weeklyUsdLimit: 500,
    });

    expect(second.created).toBe(false);
    expect(second.subscription.id).toBe(first.subscription.id);
    expect(second.subscription.expiresAt!.getTime()).toBe(firstExpiry);
    expect(await prisma.planOrder.count({
      where: { customerId: customer.id, payChannel: "TRIAL" },
    })).toBe(1);
    expect(await prisma.subscription.count({
      where: { customerId: customer.id, isTrial: true },
    })).toBe(1);
  });

  it("rejects a non-positive weekly USD limit", async () => {
    const customer = await createTestCustomer();

    await expect(trialService.grantTrial(customer.id, {
      durationDays: 3,
      weeklyUsdLimit: 0,
    })).rejects.toThrow("每周美元额度必须大于 0");

    expect(await prisma.planOrder.count({
      where: { customerId: customer.id, payChannel: "TRIAL" },
    })).toBe(0);
  });
});
