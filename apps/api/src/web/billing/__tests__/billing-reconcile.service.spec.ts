/**
 * billing-reconcile.service.spec.ts — real Prisma DB tests for stranded-paid
 * order recovery.
 *
 * Two scenarios the reconcile cron must handle idempotently:
 *   1. Stranded order with NO subscription (activation never ran) → reconcile
 *      activates AND links, exactly once.
 *   2. Stranded order whose subscription ALREADY exists (only the order.
 *      subscriptionId linkage failed) → reconcile re-links WITHOUT re-activating
 *      (expiresAt must be unchanged — no double-extend / free month).
 */
import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BillingReconcileService } from "../billing-reconcile.service";
import { SubscriptionService } from "../../../subscription/subscription.service";
import { EntitlementSyncService } from "../../../subscription/entitlement-sync.service";
import { RosettaService } from "../../../rosetta/rosetta.service";
import { AccessKeyStore } from "../../../token-server/access-key-store";
import {
  cleanCustomerTables,
  createTestCustomer,
  disconnectCustomerDb,
  ensureCustomerSchema,
  getCustomerPrisma,
} from "../../../__tests__/customer-test-db";

const prisma = getCustomerPrisma();
const DAY_MS = 24 * 60 * 60 * 1000;

let tmpDir: string;
let accessKeysPath: string;
let store: AccessKeyStore;
let subscriptionService: SubscriptionService;
let entitlementSync: EntitlementSyncService;
let reconcileService: BillingReconcileService;

async function createTestPlan(overrides: Partial<Record<string, any>> = {}) {
  return prisma.plan.create({
    data: {
      name: overrides.name ?? "Pro 月卡",
      priceCents: overrides.priceCents ?? 990,
      durationDays: overrides.durationDays ?? 30,
      productEntitlements: overrides.productEntitlements ?? JSON.stringify(["antigravity"]),
      bucketLimits: overrides.bucketLimits ?? JSON.stringify({ "antigravity-gemini": 1_000_000 }),
      levels: overrides.levels ?? JSON.stringify({ antigravity: "ultra" }),
      weight: overrides.weight ?? 1,
      deviceLimit: overrides.deviceLimit ?? 3,
      weeklyTokenLimit: overrides.weeklyTokenLimit ?? 5_000_000,
      windowMs: overrides.windowMs ?? 18_000_000,
      active: true,
    },
  });
}

/** Create a PAID order with subscriptionId=null, paidAt in the past. */
async function createStrandedOrder(customerId: string, planId: string, paidAt: Date) {
  return prisma.planOrder.create({
    data: {
      customerId,
      planId,
      amountCents: 990,
      payChannel: "ALIPAY",
      outTradeNo: `gfa-stranded-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: "PAID",
      paidAt,
      subscriptionId: null,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    },
  });
}

beforeAll(async () => {
  await ensureCustomerSchema();
});

beforeEach(async () => {
  await prisma.referralReward.deleteMany();
  await cleanCustomerTables();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "billing-recon-"));
  accessKeysPath = path.join(tmpDir, "access-keys.json");
  fs.writeFileSync(accessKeysPath, JSON.stringify({ keys: [], updatedAt: "" }));
  fs.writeFileSync(path.join(tmpDir, "accounts.json"), JSON.stringify({
    accounts: [
      { id: 1, email: "ultra-1@pool.test", refreshToken: "rt", enabled: true, projectId: "p1", planType: "ultra" },
    ],
  }));

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
  subscriptionService = new SubscriptionService(prisma as any, entitlementSync);
  reconcileService = new BillingReconcileService(prisma as any, subscriptionService);
});

afterEach(async () => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  await prisma.referralReward.deleteMany();
  await cleanCustomerTables();
  await disconnectCustomerDb();
});

describe("BillingReconcileService.reconcileOne", () => {
  it("stranded order with NO subscription → activates and links once", async () => {
    const customer = await createTestCustomer();
    const plan = await createTestPlan();
    const order = await createStrandedOrder(customer.id, plan.id, new Date(Date.now() - 10 * 60 * 1000));

    // Precondition: no subscription yet.
    expect(await prisma.subscription.count({ where: { customerId: customer.id } })).toBe(0);

    await reconcileService.reconcileOne(order);

    // Activation ran exactly once → one ACTIVE subscription, order linked.
    const subs = await prisma.subscription.findMany({ where: { customerId: customer.id } });
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe("ACTIVE");

    const refreshed = await prisma.planOrder.findUnique({ where: { id: order.id } });
    expect(refreshed!.subscriptionId).toBe(subs[0].id);
  });

  it("stranded order whose sub ALREADY exists (linkage-only failure) → re-links WITHOUT double-extending", async () => {
    const customer = await createTestCustomer();
    const plan = await createTestPlan({ durationDays: 30 });
    const paidAt = new Date(Date.now() - 10 * 60 * 1000);
    const order = await createStrandedOrder(customer.id, plan.id, paidAt);

    // Simulate "activation already ran but linkage failed": create the ACTIVE
    // sub now (its updatedAt will be >= paidAt). The order still has
    // subscriptionId=null.
    const existingSub = await subscriptionService.activateOrExtend(customer.id, plan.id, { orderId: order.id });
    const expiryBefore = existingSub.expiresAt!.getTime();

    // Sanity: exactly one sub, order still unlinked.
    expect(await prisma.subscription.count({ where: { customerId: customer.id } })).toBe(1);
    const before = await prisma.planOrder.findUnique({ where: { id: order.id } });
    expect(before!.subscriptionId).toBeNull();

    await reconcileService.reconcileOne(order);

    // Must NOT have created a second sub nor extended the existing one.
    const subs = await prisma.subscription.findMany({ where: { customerId: customer.id } });
    expect(subs).toHaveLength(1);
    expect(subs[0].id).toBe(existingSub.id);
    expect(subs[0].expiresAt!.getTime()).toBe(expiryBefore); // no double-extend

    // Order is now linked to the pre-existing sub.
    const after = await prisma.planOrder.findUnique({ where: { id: order.id } });
    expect(after!.subscriptionId).toBe(existingSub.id);
  });

  it("is idempotent across repeated runs (second run is a no-op)", async () => {
    const customer = await createTestCustomer();
    const plan = await createTestPlan({ durationDays: 30 });
    const order = await createStrandedOrder(customer.id, plan.id, new Date(Date.now() - 10 * 60 * 1000));

    await reconcileService.reconcileOne(order);
    const subsAfter1 = await prisma.subscription.findMany({ where: { customerId: customer.id } });
    expect(subsAfter1).toHaveLength(1);
    const expiry1 = subsAfter1[0].expiresAt!.getTime();

    // Re-fetch the (now linked) order and run again — should be a no-op re-link.
    const relinkedOrder = await prisma.planOrder.findUnique({ where: { id: order.id } });
    // Clear the link to force the reconcile to re-evaluate (simulates a stale read).
    await prisma.planOrder.update({ where: { id: order.id }, data: { subscriptionId: null } });

    await reconcileService.reconcileOne({ ...relinkedOrder!, subscriptionId: null } as any);

    const subsAfter2 = await prisma.subscription.findMany({ where: { customerId: customer.id } });
    expect(subsAfter2).toHaveLength(1); // still one — no double activation
    expect(subsAfter2[0].expiresAt!.getTime()).toBe(expiry1); // no extend
  });
});

describe("BillingReconcileService.reconcileStrandedOrders (cron)", () => {
  it("only processes orders older than the min-age cutoff", async () => {
    const customer = await createTestCustomer();
    const plan = await createTestPlan();

    // Fresh stranded order (paidAt = now) — should be SKIPPED (too recent).
    const fresh = await createStrandedOrder(customer.id, plan.id, new Date());
    // Old stranded order — should be processed.
    const old = await createStrandedOrder(customer.id, plan.id, new Date(Date.now() - 10 * 60 * 1000));

    await reconcileService.reconcileStrandedOrders();

    const freshAfter = await prisma.planOrder.findUnique({ where: { id: fresh.id } });
    const oldAfter = await prisma.planOrder.findUnique({ where: { id: old.id } });

    expect(freshAfter!.subscriptionId).toBeNull(); // untouched (too recent)
    expect(oldAfter!.subscriptionId).toBeTruthy(); // reconciled
  });

  it("per-order failure does not abort the batch (one bad order, one good)", async () => {
    const goodCustomer = await createTestCustomer();
    const badCustomer = await createTestCustomer();
    const plan = await createTestPlan({ name: "shared" });
    const good = await createStrandedOrder(goodCustomer.id, plan.id, new Date(Date.now() - 10 * 60 * 1000));
    const bad = await createStrandedOrder(badCustomer.id, plan.id, new Date(Date.now() - 10 * 60 * 1000));

    // Make activation fail for the bad customer only (simulates seat exhaustion
    // / transient activation error), leaving the good order to succeed.
    const realActivate = subscriptionService.activateOrExtend.bind(subscriptionService);
    vi.spyOn(subscriptionService, "activateOrExtend").mockImplementation(
      async (customerId: string, planId: string, opts?: any) => {
        if (customerId === badCustomer.id) throw new Error("seat exhaustion (simulated)");
        return realActivate(customerId, planId, opts);
      },
    );

    // Should not throw despite the bad order.
    await expect(reconcileService.reconcileStrandedOrders()).resolves.toBeUndefined();

    // Good order still reconciled.
    const goodAfter = await prisma.planOrder.findUnique({ where: { id: good.id } });
    expect(goodAfter!.subscriptionId).toBeTruthy();
    // Bad order remains unlinked (retried next tick).
    const badAfter = await prisma.planOrder.findUnique({ where: { id: bad.id } });
    expect(badAfter!.subscriptionId).toBeNull();
  });
});
