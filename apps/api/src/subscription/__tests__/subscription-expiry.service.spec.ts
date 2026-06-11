/**
 * subscription-expiry.service.spec.ts — hourly expiry cron against the real
 * Prisma test db with a mocked EntitlementSyncService (record side is covered
 * by subscription.service.spec / entitlement-sync.service.spec).
 *
 * Contract: ACTIVE subs whose expiresAt has passed flip to EXPIRED and their
 * shadow record is expired (frees the seat). Null-expiry, future-expiry and
 * already-terminal subs are untouched; one bad sub never aborts the batch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SubscriptionExpiryService } from "../subscription-expiry.service";
import type { EntitlementSyncService } from "../entitlement-sync.service";
import {
  cleanCustomerTables,
  createTestCustomer,
  disconnectCustomerDb,
  ensureCustomerSchema,
  getCustomerPrisma,
} from "../../__tests__/customer-test-db";

const prisma = getCustomerPrisma();
const DAY_MS = 24 * 60 * 60 * 1000;

let entitlementSync: { expireShadowRecord: ReturnType<typeof vi.fn> };
let service: SubscriptionExpiryService;

async function createSub(customerId: string, overrides: Partial<{
  id: string;
  status: "ACTIVE" | "EXPIRED" | "CANCELLED";
  expiresAt: Date | null;
}> = {}) {
  return prisma.subscription.create({
    data: {
      ...(overrides.id ? { id: overrides.id } : {}),
      customerId,
      status: (overrides.status ?? "ACTIVE") as any,
      startsAt: new Date(),
      expiresAt: overrides.expiresAt === undefined ? new Date(Date.now() - 1000) : overrides.expiresAt,
      productEntitlements: JSON.stringify(["antigravity"]),
      backingKeyValue: `sub_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`,
    },
  });
}

beforeAll(async () => {
  await ensureCustomerSchema();
});

beforeEach(async () => {
  await cleanCustomerTables();
  entitlementSync = { expireShadowRecord: vi.fn() };
  service = new SubscriptionExpiryService(
    prisma as any,
    entitlementSync as unknown as EntitlementSyncService,
  );
});

afterAll(async () => {
  await cleanCustomerTables();
  await disconnectCustomerDb();
});

describe("SubscriptionExpiryService.expireDue", () => {
  it("flips a due ACTIVE sub to EXPIRED and expires its shadow record", async () => {
    const customer = await createTestCustomer();
    const sub = await createSub(customer.id, { expiresAt: new Date(Date.now() - 60_000) });

    const result = await service.expireDue();

    expect(result).toEqual({ expired: 1, failed: 0 });
    expect((await prisma.subscription.findUnique({ where: { id: sub.id } }))!.status).toBe("EXPIRED");
    expect(entitlementSync.expireShadowRecord).toHaveBeenCalledTimes(1);
    expect(entitlementSync.expireShadowRecord).toHaveBeenCalledWith(sub.id);
  });

  it("leaves not-yet-expired and null-expiry (never-used migrated) subs untouched", async () => {
    const customer = await createTestCustomer();
    const future = await createSub(customer.id, { expiresAt: new Date(Date.now() + 30 * DAY_MS) });
    const nullExpiry = await createSub(customer.id, { expiresAt: null });

    const result = await service.expireDue();

    expect(result).toEqual({ expired: 0, failed: 0 });
    expect((await prisma.subscription.findUnique({ where: { id: future.id } }))!.status).toBe("ACTIVE");
    expect((await prisma.subscription.findUnique({ where: { id: nullExpiry.id } }))!.status).toBe("ACTIVE");
    expect(entitlementSync.expireShadowRecord).not.toHaveBeenCalled();
  });

  it("skips already-EXPIRED and CANCELLED subs (idempotent re-run)", async () => {
    const customer = await createTestCustomer();
    await createSub(customer.id, { status: "EXPIRED", expiresAt: new Date(Date.now() - DAY_MS) });
    await createSub(customer.id, { status: "CANCELLED", expiresAt: new Date(Date.now() - DAY_MS) });

    const result = await service.expireDue();

    expect(result).toEqual({ expired: 0, failed: 0 });
    expect(entitlementSync.expireShadowRecord).not.toHaveBeenCalled();
  });

  it("is idempotent: a second run after a successful pass finds nothing to do", async () => {
    const customer = await createTestCustomer();
    await createSub(customer.id, { expiresAt: new Date(Date.now() - 60_000) });

    expect(await service.expireDue()).toEqual({ expired: 1, failed: 0 });
    expect(await service.expireDue()).toEqual({ expired: 0, failed: 0 });
    expect(entitlementSync.expireShadowRecord).toHaveBeenCalledTimes(1);
  });

  it("one failing sub does not abort the batch (failure isolated + counted)", async () => {
    const customer = await createTestCustomer();
    const bad = await createSub(customer.id, { id: "sub-shadow-throws", expiresAt: new Date(Date.now() - 2000) });
    const good = await createSub(customer.id, { id: "sub-shadow-ok", expiresAt: new Date(Date.now() - 1000) });
    entitlementSync.expireShadowRecord.mockImplementation((id: string) => {
      if (id === bad.id) throw new Error("record write boom");
    });

    const result = await service.expireDue();

    expect(result).toEqual({ expired: 1, failed: 1 });
    // The good sub fully processed despite the earlier failure.
    expect((await prisma.subscription.findUnique({ where: { id: good.id } }))!.status).toBe("EXPIRED");
    expect(entitlementSync.expireShadowRecord).toHaveBeenCalledWith(good.id);
    // The DB flip for the bad sub still happened (row is EXPIRED; the record is
    // harmless either way — its keyExpiresAt mirrors the same past date, so the
    // lease engine rejects it and self-expires its status on next resolve).
    expect((await prisma.subscription.findUnique({ where: { id: bad.id } }))!.status).toBe("EXPIRED");
  });

  it("re-checks expiry in the CAS update (a sub renewed mid-batch is NOT expired)", async () => {
    const customer = await createTestCustomer();
    const sub = await createSub(customer.id, { expiresAt: new Date(Date.now() - 1000) });
    // Simulate a concurrent renewal between findMany and the CAS update.
    const renewedExpiry = new Date(Date.now() + 30 * DAY_MS);
    const originalFindMany = prisma.subscription.findMany.bind(prisma.subscription);
    const spy = vi.spyOn(prisma.subscription, "findMany").mockImplementation(async (args: any) => {
      const rows = await originalFindMany(args);
      await prisma.subscription.update({ where: { id: sub.id }, data: { expiresAt: renewedExpiry } });
      return rows as any;
    });

    const result = await service.expireDue();
    spy.mockRestore();

    expect(result).toEqual({ expired: 0, failed: 0 });
    expect((await prisma.subscription.findUnique({ where: { id: sub.id } }))!.status).toBe("ACTIVE");
    expect(entitlementSync.expireShadowRecord).not.toHaveBeenCalled();
  });
});
