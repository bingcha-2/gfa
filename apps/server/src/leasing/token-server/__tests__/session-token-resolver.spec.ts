/**
 * session-token-resolver.spec.ts — SessionTokenResolver against the real
 * Prisma test db (Customer / Device / Subscription rows).
 *
 * Error contract (consumed verbatim by the desktop client):
 *   bad sig / tv bump / disabled / web token without deviceId → 401 SESSION_INVALID
 *   device missing / REVOKED / rotated jti                    → 403 DEVICE_REVOKED
 *   no ACTIVE unexpired sub covering the product              → 403 SUBSCRIPTION_EXPIRED
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JwtService } from "@nestjs/jwt";

import { SessionTokenResolver } from "../session-token-resolver";
import { AccessKeyStore } from "../access-key-store";
import { CustomerTokenService } from "../../web/customer-auth/customer-token.service";
import {
  cleanCustomerTables,
  createTestCustomer,
  decodeJwtPayload,
  disconnectCustomerDb,
  ensureCustomerSchema,
  getCustomerPrisma,
} from "../../../shared/__tests__/customer-test-db";

process.env.CUSTOMER_JWT_SECRET =
  process.env.CUSTOMER_JWT_SECRET || "session-token-resolver-spec-secret-0123456789abcdef";

const prisma = getCustomerPrisma();
const tokens = new CustomerTokenService(new JwtService({}));
const resolver = new SessionTokenResolver(tokens, prisma as any);

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedCustomerWithDevice(overrides: { tokenVersion?: number } = {}) {
  const customer = await createTestCustomer({ tokenVersion: overrides.tokenVersion ?? 0 });
  const token = tokens.sign({
    customerId: customer.id,
    email: customer.email,
    tokenVersion: customer.tokenVersion,
    deviceId: "device-1",
  });
  const jti = decodeJwtPayload(token).jti as string;
  const device = await prisma.device.create({
    data: { customerId: customer.id, deviceId: "device-1", status: "ACTIVE", sessionJti: jti },
  });
  return { customer, token, jti, device };
}

function subData(customerId: string, overrides: Partial<{
  id: string;
  expiresAt: Date | null;
  products: string[];
  status: "ACTIVE" | "EXPIRED" | "CANCELLED";
}> = {}) {
  return {
    ...(overrides.id ? { id: overrides.id } : {}),
    customerId,
    status: (overrides.status ?? "ACTIVE") as any,
    startsAt: new Date(),
    expiresAt: overrides.expiresAt === undefined ? new Date(Date.now() + 30 * DAY_MS) : overrides.expiresAt,
    productEntitlements: JSON.stringify(overrides.products ?? ["antigravity", "codex", "anthropic"]),
    backingKeyValue: `sub_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`,
  };
}

beforeAll(async () => {
  await ensureCustomerSchema();
});

beforeEach(async () => {
  await cleanCustomerTables();
});

afterAll(async () => {
  await cleanCustomerTables();
  await disconnectCustomerDb();
});

describe("SessionTokenResolver", () => {
  it("valid app token + ACTIVE device + covering sub → {ok, cardId: sub.id}", async () => {
    const { customer, token } = await seedCustomerWithDevice();
    const sub = await prisma.subscription.create({
      data: subData(customer.id, { products: ["antigravity"] }),
    });

    const result = await resolver.resolve(token, { product: "antigravity" });

    expect(result).toEqual({ ok: true, cardId: sub.id });
  });

  it("web token (no deviceId claim) → 401 SESSION_INVALID with a client-login message", async () => {
    const { customer } = await seedCustomerWithDevice();
    const webToken = tokens.sign({
      customerId: customer.id,
      email: customer.email,
      tokenVersion: customer.tokenVersion,
    });
    await prisma.subscription.create({ data: subData(customer.id) });

    const result = await resolver.resolve(webToken, { product: "codex" });

    expect(result).toMatchObject({ ok: false, statusCode: 401, error: "SESSION_INVALID" });
    expect((result as any).message).toContain("客户端");
  });

  it("garbage / unsigned token → 401 SESSION_INVALID", async () => {
    const result = await resolver.resolve("not-a-jwt", {});
    expect(result).toMatchObject({ ok: false, statusCode: 401, error: "SESSION_INVALID" });
  });

  it("tokenVersion bump revokes the token → 401 SESSION_INVALID", async () => {
    const { customer, token } = await seedCustomerWithDevice();
    await prisma.subscription.create({ data: subData(customer.id) });
    await prisma.customer.update({ where: { id: customer.id }, data: { tokenVersion: 1 } });

    const result = await resolver.resolve(token, { product: "codex" });

    expect(result).toMatchObject({ ok: false, statusCode: 401, error: "SESSION_INVALID" });
  });

  it("disabled customer → 401 SESSION_INVALID", async () => {
    const { customer, token } = await seedCustomerWithDevice();
    await prisma.customer.update({ where: { id: customer.id }, data: { status: "DISABLED" } });

    const result = await resolver.resolve(token, {});

    expect(result).toMatchObject({ ok: false, statusCode: 401, error: "SESSION_INVALID" });
  });

  it("revoked device → 403 DEVICE_REVOKED", async () => {
    const { customer, token } = await seedCustomerWithDevice();
    await prisma.subscription.create({ data: subData(customer.id) });
    await prisma.device.updateMany({
      where: { customerId: customer.id },
      data: { status: "REVOKED" },
    });

    const result = await resolver.resolve(token, { product: "codex" });

    expect(result).toMatchObject({ ok: false, statusCode: 403, error: "DEVICE_REVOKED" });
  });

  it("stale jti (device re-login rotated the session) → 403 DEVICE_REVOKED", async () => {
    const { customer, token } = await seedCustomerWithDevice();
    await prisma.subscription.create({ data: subData(customer.id) });
    await prisma.device.updateMany({
      where: { customerId: customer.id },
      data: { sessionJti: "a-newer-session-jti" },
    });

    const result = await resolver.resolve(token, { product: "codex" });

    expect(result).toMatchObject({ ok: false, statusCode: 403, error: "DEVICE_REVOKED" });
  });

  it("device row missing → 403 DEVICE_REVOKED", async () => {
    const { customer, token } = await seedCustomerWithDevice();
    await prisma.subscription.create({ data: subData(customer.id) });
    await prisma.device.deleteMany({ where: { customerId: customer.id } });

    const result = await resolver.resolve(token, { product: "codex" });

    expect(result).toMatchObject({ ok: false, statusCode: 403, error: "DEVICE_REVOKED" });
  });

  it("no subscription at all → 403 SUBSCRIPTION_EXPIRED (无有效订阅或已到期)", async () => {
    const { token } = await seedCustomerWithDevice();

    const result = await resolver.resolve(token, { product: "codex" });

    expect(result).toMatchObject({
      ok: false, statusCode: 403, error: "SUBSCRIPTION_EXPIRED", message: "无有效订阅或已到期",
    });
  });

  it("expired subscription → 403 SUBSCRIPTION_EXPIRED", async () => {
    const { customer, token } = await seedCustomerWithDevice();
    await prisma.subscription.create({
      data: subData(customer.id, { expiresAt: new Date(Date.now() - 1000) }),
    });

    const result = await resolver.resolve(token, { product: "codex" });

    expect(result).toMatchObject({ ok: false, statusCode: 403, error: "SUBSCRIPTION_EXPIRED" });
  });

  it("active sub NOT covering the requested product → 403 SUBSCRIPTION_EXPIRED", async () => {
    const { customer, token } = await seedCustomerWithDevice();
    await prisma.subscription.create({
      data: subData(customer.id, { products: ["antigravity"] }),
    });

    const result = await resolver.resolve(token, { product: "anthropic" });

    expect(result).toMatchObject({ ok: false, statusCode: 403, error: "SUBSCRIPTION_EXPIRED" });
  });

  it("CANCELLED sub does not authorize → 403 SUBSCRIPTION_EXPIRED", async () => {
    const { customer, token } = await seedCustomerWithDevice();
    await prisma.subscription.create({
      data: subData(customer.id, { status: "CANCELLED" }),
    });

    const result = await resolver.resolve(token, { product: "codex" });

    expect(result).toMatchObject({ ok: false, statusCode: 403, error: "SUBSCRIPTION_EXPIRED" });
  });

  it("picks the covering sub with the greatest expiry (null treated as infinity)", async () => {
    const { customer, token } = await seedCustomerWithDevice();
    await prisma.subscription.create({
      data: subData(customer.id, { id: "sub-short", expiresAt: new Date(Date.now() + 5 * DAY_MS) }),
    });
    const long = await prisma.subscription.create({
      data: subData(customer.id, { id: "sub-null-expiry", expiresAt: null }),
    });
    await prisma.subscription.create({
      data: subData(customer.id, { id: "sub-long", expiresAt: new Date(Date.now() + 60 * DAY_MS) }),
    });

    const result = await resolver.resolve(token, { product: "codex" });

    expect(result).toEqual({ ok: true, cardId: long.id });
  });

  it("product-less resolve (report path) accepts any active sub", async () => {
    const { customer, token } = await seedCustomerWithDevice();
    const sub = await prisma.subscription.create({
      data: subData(customer.id, { products: ["antigravity"] }),
    });

    const result = await resolver.resolve(token, {});

    expect(result).toEqual({ ok: true, cardId: sub.id });
  });
});

describe("SessionTokenResolver.onShadowRecordFirstUse — first-use expiry resync", () => {
  it("persists the effective expiry onto a null-expiry subscription", async () => {
    const { customer } = await seedCustomerWithDevice();
    const sub = await prisma.subscription.create({
      data: subData(customer.id, { expiresAt: null }),
    });
    const effective = new Date(Date.now() + 7 * DAY_MS);

    await resolver.onShadowRecordFirstUse(sub.id, effective.toISOString());

    const after = await prisma.subscription.findUnique({ where: { id: sub.id } });
    expect(after!.expiresAt!.toISOString()).toBe(effective.toISOString());
  });

  it("never clobbers an already-set Subscription.expiresAt (idempotent guard)", async () => {
    const { customer } = await seedCustomerWithDevice();
    const original = new Date(Date.now() + 30 * DAY_MS);
    const sub = await prisma.subscription.create({
      data: subData(customer.id, { expiresAt: original }),
    });

    await resolver.onShadowRecordFirstUse(sub.id, new Date(Date.now() + 7 * DAY_MS).toISOString());

    const after = await prisma.subscription.findUnique({ where: { id: sub.id } });
    expect(after!.expiresAt!.toISOString()).toBe(original.toISOString());
  });

  it("ignores garbage input and unknown ids without throwing (best-effort contract)", async () => {
    await expect(resolver.onShadowRecordFirstUse("ghost-sub", "not-a-date")).resolves.toBeUndefined();
    await expect(resolver.onShadowRecordFirstUse("", new Date().toISOString())).resolves.toBeUndefined();
    await expect(
      resolver.onShadowRecordFirstUse("ghost-sub", new Date().toISOString()),
    ).resolves.toBeUndefined();
  });

  it("END-TO-END: first session lease on a never-used migrated card resyncs Subscription.expiresAt to the record's effective expiry", async () => {
    const { customer, token } = await seedCustomerWithDevice();
    // Migrated never-used card: Subscription.expiresAt null, shadow record with
    // record.id == sub.id, relative durationMs, NOT yet armed.
    const sub = await prisma.subscription.create({
      data: subData(customer.id, { id: "card-mig-resync", expiresAt: null }),
    });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "first-use-resync-"));
    const accessKeysPath = path.join(tmpDir, "access-keys.json");
    fs.writeFileSync(accessKeysPath, JSON.stringify({
      keys: [{ id: sub.id, key: sub.backingKeyValue, status: "active", durationMs: 7 * DAY_MS }],
      updatedAt: "",
    }));
    try {
      const store = new AccessKeyStore(accessKeysPath);
      store.setSessionResolver(resolver);

      const result = await store.resolveFromRequest(
        { headers: { authorization: `Bearer ${token}` } } as any,
        {},
        { activate: true, product: "antigravity" },
      );
      expect(result.record?.id).toBe(sub.id);
      const expectedExpiry = new Date(Date.parse(result.record!.firstUsedAt!) + 7 * DAY_MS);

      // The hook is fire-and-forget off the lease path — poll for the write.
      await expect
        .poll(async () => (await prisma.subscription.findUnique({ where: { id: sub.id } }))!.expiresAt?.toISOString(), {
          timeout: 5000,
        })
        .toBe(expectedExpiry.toISOString());
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
