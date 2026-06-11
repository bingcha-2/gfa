/**
 * subscription.service.spec.ts — subscription lifecycle rules against the real
 * Prisma test db, with a REAL EntitlementSyncService writing shadow records
 * into a tmp access-keys.json (integration through the single writer).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SubscriptionService } from "../subscription.service";
import { EntitlementSyncService } from "../entitlement-sync.service";
import { RosettaService } from "../../rosetta/rosetta.service";
import { AccessKeyStore } from "../../token-server/access-key-store";
import {
  cleanCustomerTables,
  createTestCustomer,
  disconnectCustomerDb,
  ensureCustomerSchema,
  getCustomerPrisma,
} from "../../__tests__/customer-test-db";

const prisma = getCustomerPrisma();
const DAY_MS = 24 * 60 * 60 * 1000;

let tmpDir: string;
let accessKeysPath: string;
let store: AccessKeyStore;
let service: SubscriptionService;

function readKeys(): any[] {
  return JSON.parse(fs.readFileSync(accessKeysPath, "utf8")).keys;
}

async function createPlan(overrides: Partial<Record<string, any>> = {}) {
  return prisma.plan.create({
    data: {
      name: overrides.name ?? "Pro 月卡",
      priceCents: overrides.priceCents ?? 9900,
      durationDays: overrides.durationDays ?? 30,
      productEntitlements: overrides.productEntitlements ?? JSON.stringify(["antigravity"]),
      bucketLimits: overrides.bucketLimits ?? JSON.stringify({ "antigravity-gemini": 1_000_000 }),
      levels: overrides.levels ?? JSON.stringify({ antigravity: "ultra" }),
      weight: overrides.weight ?? 1,
      deviceLimit: overrides.deviceLimit ?? 3,
      weeklyTokenLimit: overrides.weeklyTokenLimit ?? 5_000_000,
      windowMs: overrides.windowMs ?? 18_000_000,
    },
  });
}

beforeAll(async () => {
  await ensureCustomerSchema();
});

beforeEach(async () => {
  await cleanCustomerTables();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subscription-svc-"));
  accessKeysPath = path.join(tmpDir, "access-keys.json");
  fs.writeFileSync(accessKeysPath, JSON.stringify({ keys: [], updatedAt: "" }));
  fs.writeFileSync(path.join(tmpDir, "accounts.json"), JSON.stringify({
    accounts: [
      { id: 1, email: "ultra-1@pool.test", refreshToken: "rt", enabled: true, projectId: "p1", planType: "ultra" },
      { id: 2, email: "ultra-2@pool.test", refreshToken: "rt", enabled: true, projectId: "p2", planType: "ultra" },
    ],
  }));

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
  service = new SubscriptionService(prisma as any, sync);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  await cleanCustomerTables();
  await disconnectCustomerDb();
});

describe("SubscriptionService.createFromPlan / activateOrExtend", () => {
  it("creates an ACTIVE sub with plan snapshots, sub_+48hex backing key, and a shadow record", async () => {
    const customer = await createTestCustomer();
    const plan = await createPlan();

    const sub = await service.activateOrExtend(customer.id, plan.id);

    expect(sub.status).toBe("ACTIVE");
    expect(sub.planId).toBe(plan.id);
    expect(sub.customerId).toBe(customer.id);
    expect(sub.backingKeyValue).toMatch(/^sub_[0-9a-f]{48}$/);
    expect(sub.productEntitlements).toBe(plan.productEntitlements);
    expect(sub.bucketLimits).toBe(plan.bucketLimits);
    expect(sub.weight).toBe(plan.weight);
    expect(sub.deviceLimit).toBe(plan.deviceLimit);
    expect(sub.weeklyTokenLimit).toBe(plan.weeklyTokenLimit);
    expect(sub.windowMs).toBe(plan.windowMs);
    const expectedExpiry = Date.now() + 30 * DAY_MS;
    expect(Math.abs(sub.expiresAt!.getTime() - expectedExpiry)).toBeLessThan(60_000);
    // Auto-assigned seat persisted onto the row snapshot.
    expect(JSON.parse(sub.bindings!)).toEqual({ antigravity: expect.any(Number) });

    const record = readKeys().find((k) => k.id === sub.id);
    expect(record).toBeTruthy();
    expect(record.key).toBe(sub.backingKeyValue);
    expect(record.keyExpiresAt).toBe(sub.expiresAt!.toISOString());
    expect(record.name).toContain(customer.email);
  });

  it("same plan again → EXTENDS the same sub (expiry += durationDays), no second sub or record", async () => {
    const customer = await createTestCustomer();
    const plan = await createPlan({ durationDays: 30 });

    const first = await service.activateOrExtend(customer.id, plan.id);
    const second = await service.activateOrExtend(customer.id, plan.id);

    expect(second.id).toBe(first.id);
    expect(second.expiresAt!.getTime() - first.expiresAt!.getTime()).toBe(30 * DAY_MS);
    expect(await prisma.subscription.count({ where: { customerId: customer.id } })).toBe(1);
    expect(readKeys()).toHaveLength(1);
    expect(readKeys()[0].keyExpiresAt).toBe(second.expiresAt!.toISOString());
  });

  it("a different plan with INTERSECTING products cancels the old sub and expires its record", async () => {
    const customer = await createTestCustomer();
    const planA = await createPlan({ name: "A", productEntitlements: JSON.stringify(["antigravity", "codex"]) });
    const planB = await createPlan({ name: "B", productEntitlements: JSON.stringify(["codex"]) });

    const subA = await service.activateOrExtend(customer.id, planA.id);
    const subB = await service.activateOrExtend(customer.id, planB.id);

    const reloadedA = await prisma.subscription.findUnique({ where: { id: subA.id } });
    expect(reloadedA!.status).toBe("CANCELLED");
    expect(subB.status).toBe("ACTIVE");
    expect(subB.id).not.toBe(subA.id);

    const recordA = readKeys().find((k) => k.id === subA.id);
    const recordB = readKeys().find((k) => k.id === subB.id);
    expect(recordA.status).toBe("expired");
    expect(recordB.status).toBe("active");
  });

  it("a different plan with DISJOINT products leaves the old sub active (coexist)", async () => {
    const customer = await createTestCustomer();
    const planA = await createPlan({ name: "A", productEntitlements: JSON.stringify(["antigravity"]) });
    const planB = await createPlan({
      name: "B",
      productEntitlements: JSON.stringify(["codex"]),
      levels: JSON.stringify({ codex: "pro" }),
    });

    const subA = await service.activateOrExtend(customer.id, planA.id);
    const subB = await service.activateOrExtend(customer.id, planB.id);

    expect((await prisma.subscription.findUnique({ where: { id: subA.id } }))!.status).toBe("ACTIVE");
    expect(subB.status).toBe("ACTIVE");
    expect(readKeys().filter((k) => k.status === "active")).toHaveLength(2);
  });

  it("migrated card subs (planId null) are NEVER auto-cancelled by purchases", async () => {
    const customer = await createTestCustomer();
    const migrated = await prisma.subscription.create({
      data: {
        id: "card-mig-1",
        customerId: customer.id,
        planId: null,
        status: "ACTIVE",
        productEntitlements: JSON.stringify(["antigravity", "codex", "anthropic"]),
        backingKeyValue: "sub_" + "b".repeat(48),
        expiresAt: null,
      },
    });
    const plan = await createPlan({ productEntitlements: JSON.stringify(["antigravity"]) });

    const sub = await service.activateOrExtend(customer.id, plan.id);

    expect(sub.status).toBe("ACTIVE");
    const migratedAfter = await prisma.subscription.findUnique({ where: { id: migrated.id } });
    expect(migratedAfter!.status).toBe("ACTIVE");
  });

  it("expireSubscription / cancelSubscription set the status and expire the shadow record", async () => {
    const customer = await createTestCustomer();
    const plan = await createPlan();
    const sub = await service.activateOrExtend(customer.id, plan.id);

    await service.expireSubscription(sub.id);
    expect((await prisma.subscription.findUnique({ where: { id: sub.id } }))!.status).toBe("EXPIRED");
    expect(readKeys().find((k) => k.id === sub.id).status).toBe("expired");

    const sub2 = await service.createFromPlan(customer.id, plan);
    await service.cancelSubscription(sub2.id);
    expect((await prisma.subscription.findUnique({ where: { id: sub2.id } }))!.status).toBe("CANCELLED");
    expect(readKeys().find((k) => k.id === sub2.id).status).toBe("expired");
  });

  it("activateOrExtend with an unknown plan throws NotFound", async () => {
    const customer = await createTestCustomer();
    await expect(service.activateOrExtend(customer.id, "no-such-plan")).rejects.toThrow(/not found/i);
  });
});
