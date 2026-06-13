/**
 * billing-reconcile.service.spec.ts — real Prisma DB tests for stranded-paid
 * order recovery (catalog-only orders).
 *
 * Disambiguation is EXACT via Subscription.activatedFromOrderId (M13b):
 *   1. Stranded order with NO subscription (activation never ran) → reconcile
 *      activates AND links, exactly once.
 *   2. Stranded order whose subscription recorded activatedFromOrderId ==
 *      order.id (only the order.subscriptionId linkage failed) → re-link
 *      WITHOUT re-activating (expiresAt unchanged — no double-extend).
 *   3. A same-config ACTIVE sub linked to a DIFFERENT order is NOT exact
 *      evidence: reconcile re-drives activation, which (for a same-config sub)
 *      EXTENDS it — the customer receives the time the stranded order paid for.
 */
import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BillingReconcileService } from "../billing-reconcile.service";
import { SubscriptionService } from "../../../subscription/subscription.service";
import { EntitlementSyncService } from "../../../subscription/entitlement-sync.service";
import { PlanCatalogService } from "../../../plan-catalog/plan-catalog.service";
import { RosettaService } from "../../../rosetta/rosetta.service";
import { AccessKeyStore } from "../../../token-server/access-key-store";
import {
  cleanCustomerTables,
  createTestCustomer,
  disconnectCustomerDb,
  ensureCustomerSchema,
  getCustomerPrisma,
} from "../../../../shared/__tests__/customer-test-db";

const prisma = getCustomerPrisma();
const DAY_MS = 24 * 60 * 60 * 1000;

// Pool-line config snapshot a catalog order carries (single product, no seats).
const POOL_CONFIG = {
  line: "pool",
  products: ["antigravity"],
  bucketLimits: { "antigravity-gemini": 1_000_000 },
  weight: 1,
  deviceLimit: 1,
  weeklyTokenLimit: 5_000_000,
  windowMs: 18_000_000,
};

let tmpDir: string;
let accessKeysPath: string;
let store: AccessKeyStore;
let subscriptionService: SubscriptionService;
let entitlementSync: EntitlementSyncService;
let planCatalog: PlanCatalogService;
let reconcileService: BillingReconcileService;

/** Publish a catalog (version 1, durationDays 30) so catalog activation can resolve the validity window. */
async function publishCatalog() {
  await prisma.planCatalog.deleteMany();
  return prisma.planCatalog.create({
    data: {
      version: 1,
      status: "PUBLISHED",
      config: JSON.stringify({ durationDays: 30, windowMs: 18_000_000 }),
      publishedAt: new Date(),
    },
  });
}

/** Create a PAID catalog order with subscriptionId=null, paidAt in the past. */
async function createStrandedOrder(customerId: string, paidAt: Date) {
  return prisma.planOrder.create({
    data: {
      customerId,
      amountCents: 990,
      payChannel: "ALIPAY",
      outTradeNo: `gfa-stranded-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: "PAID",
      paidAt,
      subscriptionId: null,
      catalogVersion: 1,
      config: JSON.stringify(POOL_CONFIG),
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
  planCatalog = new PlanCatalogService(prisma as any);
  subscriptionService = new SubscriptionService(prisma as any, entitlementSync, planCatalog);
  reconcileService = new BillingReconcileService(prisma as any, subscriptionService);

  await publishCatalog();
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
    const order = await createStrandedOrder(customer.id, new Date(Date.now() - 10 * 60 * 1000));

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

  it("stranded order whose sub recorded activatedFromOrderId == order.id → re-links ONLY (no re-activation, no extend)", async () => {
    const customer = await createTestCustomer();
    const order = await createStrandedOrder(customer.id, new Date(Date.now() - 10 * 60 * 1000));

    // Simulate "activation already ran but linkage failed": activate THIS order
    // (persists activatedFromOrderId = order.id). The order still has
    // subscriptionId=null.
    const existingSub = await subscriptionService.activateForOrder(order);
    const expiryBefore = existingSub.expiresAt!.getTime();
    expect(existingSub.activatedFromOrderId).toBe(order.id);

    // Sanity: exactly one sub, order still unlinked.
    expect(await prisma.subscription.count({ where: { customerId: customer.id } })).toBe(1);
    const before = await prisma.planOrder.findUnique({ where: { id: order.id } });
    expect(before!.subscriptionId).toBeNull();

    const activateSpy = vi.spyOn(subscriptionService, "activateForOrder");

    await reconcileService.reconcileOne(order);

    // Exact-link path: activation must NOT have been re-driven at all.
    expect(activateSpy).not.toHaveBeenCalled();

    // Must NOT have created a second sub nor extended the existing one.
    const subs = await prisma.subscription.findMany({ where: { customerId: customer.id } });
    expect(subs).toHaveLength(1);
    expect(subs[0].id).toBe(existingSub.id);
    expect(subs[0].expiresAt!.getTime()).toBe(expiryBefore); // no double-extend

    // Order is now linked to the pre-existing sub.
    const after = await prisma.planOrder.findUnique({ where: { id: order.id } });
    expect(after!.subscriptionId).toBe(existingSub.id);
  });

  it("same-config sub linked to a DIFFERENT order is NOT exact evidence → stranded order is ACTIVATED (extends), not mis-relinked", async () => {
    const customer = await createTestCustomer();

    // Order A paid and FULLY activated+linked: the sub records
    // activatedFromOrderId = orderA.id.
    const orderA = await createStrandedOrder(customer.id, new Date(Date.now() - 30 * 60 * 1000));
    const sub = await subscriptionService.activateForOrder(orderA);
    await prisma.planOrder.update({ where: { id: orderA.id }, data: { subscriptionId: sub.id } });
    const expiryAfterA = sub.expiresAt!.getTime();

    // Order B: a SECOND purchase of the same config whose Phase-2 activation
    // never ran (stranded). Only an exact activatedFromOrderId match counts as
    // evidence, so reconcile re-drives activation for order B.
    const orderB = await createStrandedOrder(customer.id, new Date(Date.now() - 10 * 60 * 1000));

    const activateSpy = vi.spyOn(subscriptionService, "activateForOrder");

    await reconcileService.reconcileOne(orderB);

    // Activation MUST have been driven for order B...
    expect(activateSpy).toHaveBeenCalledTimes(1);
    expect(activateSpy).toHaveBeenCalledWith(orderB);

    // ...which, for a same-config ACTIVE sub, EXTENDS it by durationDays — the
    // customer actually receives the time order B paid for.
    const subs = await prisma.subscription.findMany({ where: { customerId: customer.id } });
    expect(subs).toHaveLength(1);
    expect(subs[0].id).toBe(sub.id);
    expect(subs[0].expiresAt!.getTime()).toBe(expiryAfterA + 30 * DAY_MS);
    expect(subs[0].activatedFromOrderId).toBe(orderB.id); // link moved to the latest activating order

    // Order B linked; order A's link untouched.
    const bAfter = await prisma.planOrder.findUnique({ where: { id: orderB.id } });
    expect(bAfter!.subscriptionId).toBe(sub.id);
    const aAfter = await prisma.planOrder.findUnique({ where: { id: orderA.id } });
    expect(aAfter!.subscriptionId).toBe(sub.id);
  });

  it("is idempotent across repeated runs (second run is a no-op)", async () => {
    const customer = await createTestCustomer();
    const order = await createStrandedOrder(customer.id, new Date(Date.now() - 10 * 60 * 1000));

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

    // Fresh stranded order (paidAt = now) — should be SKIPPED (too recent).
    const fresh = await createStrandedOrder(customer.id, new Date());
    // Old stranded order — should be processed.
    const old = await createStrandedOrder(customer.id, new Date(Date.now() - 10 * 60 * 1000));

    await reconcileService.reconcileStrandedOrders();

    const freshAfter = await prisma.planOrder.findUnique({ where: { id: fresh.id } });
    const oldAfter = await prisma.planOrder.findUnique({ where: { id: old.id } });

    expect(freshAfter!.subscriptionId).toBeNull(); // untouched (too recent)
    expect(oldAfter!.subscriptionId).toBeTruthy(); // reconciled
  });

  it("per-order failure does not abort the batch (one bad order, one good)", async () => {
    const goodCustomer = await createTestCustomer();
    const badCustomer = await createTestCustomer();
    const good = await createStrandedOrder(goodCustomer.id, new Date(Date.now() - 10 * 60 * 1000));
    const bad = await createStrandedOrder(badCustomer.id, new Date(Date.now() - 10 * 60 * 1000));

    // Make activation fail for the bad customer only (simulates seat exhaustion
    // / transient activation error), leaving the good order to succeed.
    const realActivate = subscriptionService.activateForOrder.bind(subscriptionService);
    vi.spyOn(subscriptionService, "activateForOrder").mockImplementation(
      async (order: any) => {
        if (order.customerId === badCustomer.id) throw new Error("seat exhaustion (simulated)");
        return realActivate(order);
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
