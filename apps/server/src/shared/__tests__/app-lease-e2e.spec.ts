/**
 * app-lease-e2e.spec.ts — Milestone 7 end-to-end session lease proof.
 *
 * Exercises the FULL session-lease path against the real lease engine + real
 * Prisma test db.  Covers:
 *
 *  (a) Session lease across all three providers  — proven for antigravity via a
 *      real TokenServerService call; codex and anthropic aliases are verified
 *      via Reflect.getMetadata (alias path registered correctly) + a
 *      session-resolver-resolves check against each provider's service.
 *  (b) report-result attribution to subscription.id (accessKeyId == sub.id).
 *  (c) Multi-device / no single-session lock — two clientIds lease concurrently;
 *      card regression: same card + second clientId → 409.
 *  (d) Card regression — legacy card key through the dual-registered engine.
 *  (e) Session rejection cases: revoked device, expired sub, web token.
 *
 * Controller alias proof (metadata-level) lives in
 * src/__tests__/surface-routes.spec.ts alongside the other dual-path assertions.
 */

import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JwtService } from "@nestjs/jwt";

import { TokenServerService } from "../../leasing/token-server/token-server.service";
import { RemoteCodexService } from "../../leasing/remote-codex/service/remote-codex.service";
import { RemoteAnthropicService } from "../../leasing/remote-anthropic/service/remote-anthropic.service";
import { SessionTokenResolver } from "../../leasing/token-server/session-token-resolver";
import { CustomerTokenService } from "../../leasing/account/customer-auth/customer-token.service";
import { TokenServerController } from "../../leasing/token-server/token-server.controller";
import { RemoteCodexController } from "../../leasing/remote-codex/controller/remote-codex.controller";
import { RemoteAnthropicController } from "../../leasing/remote-anthropic/controller/remote-anthropic.controller";
import {
  cleanCustomerTables,
  createTestCustomer,
  decodeJwtPayload,
  disconnectCustomerDb,
  ensureCustomerSchema,
  getCustomerPrisma,
} from "./customer-test-db";

// ── Environment setup ───────────────────────────────────────────────────────
process.env.CUSTOMER_JWT_SECRET =
  process.env.CUSTOMER_JWT_SECRET || "app-lease-e2e-spec-secret-0123456789abcdef";

const prisma = getCustomerPrisma();
const tokens = new CustomerTokenService(new JwtService({}));

// ── Helpers ─────────────────────────────────────────────────────────────────

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Seed a Customer + Device row and return a valid signed session JWT. */
async function seedCustomerWithDevice(deviceId = "device-1") {
  const customer = await createTestCustomer();
  const token = tokens.sign({
    customerId: customer.id,
    email: customer.email,
    tokenVersion: customer.tokenVersion,
    deviceId,
  });
  const jti = decodeJwtPayload(token).jti as string;
  const device = await prisma.device.create({
    data: { customerId: customer.id, deviceId, status: "ACTIVE", sessionJti: jti },
  });
  return { customer, token, jti, device };
}

/** Create a minimal Subscription covering the given products. Returns sub row. */
async function seedSubscription(
  customerId: string,
  opts: {
    id?: string;
    products?: string[];
    status?: "ACTIVE" | "EXPIRED" | "CANCELLED";
    expiresAt?: Date | null;
    backingKeyValue?: string;
  } = {},
) {
  return prisma.subscription.create({
    data: {
      ...(opts.id ? { id: opts.id } : {}),
      customerId,
      status: (opts.status ?? "ACTIVE") as any,
      startsAt: new Date(),
      expiresAt: opts.expiresAt === undefined ? new Date(Date.now() + 30 * DAY_MS) : opts.expiresAt,
      productEntitlements: JSON.stringify(opts.products ?? ["antigravity", "codex", "anthropic"]),
      backingKeyValue: opts.backingKeyValue ?? `sub_backing_${Math.random().toString(16).slice(2)}`,
    },
  });
}

/**
 * Write a shadow AccessKeyRecord for a subscription into a temp access-keys file.
 * The record id MUST equal sub.id so the session resolver → record lookup works.
 */
function writeShadowRecord(
  accessKeysFilePath: string,
  subId: string,
  backingKeyValue: string,
  extras: Record<string, unknown> = {},
) {
  writeJson(accessKeysFilePath, {
    keys: [
      {
        id: subId,
        key: backingKeyValue,
        status: "active",
        ...extras,
      },
    ],
  });
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

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

// ── Path metadata (spec (a) — canonical app/lease/* paths only) ─────────────

describe("M7 — controller paths (Reflect.getMetadata)", () => {
  it("TokenServerController registers only 'app/lease/antigravity'", () => {
    expect(Reflect.getMetadata("path", TokenServerController)).toBe(
      "app/lease/antigravity",
    );
  });

  it("RemoteCodexController registers only 'app/lease/codex'", () => {
    expect(Reflect.getMetadata("path", RemoteCodexController)).toBe(
      "app/lease/codex",
    );
  });

  it("RemoteAnthropicController registers only 'app/lease/anthropic'", () => {
    expect(Reflect.getMetadata("path", RemoteAnthropicController)).toBe(
      "app/lease/anthropic",
    );
  });
});

// ── Full session lease through TokenServerService (antigravity) ─────────────

describe("M7 — antigravity session lease (full engine path)", () => {
  let tempDir: string;
  let accountsFilePath: string;
  let accessKeysFilePath: string;
  const tokenProvider = vi.fn();
  let leaseSeq = 0;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-m7-lease-"));
    accountsFilePath = path.join(tempDir, "accounts.json");
    accessKeysFilePath = path.join(tempDir, "access-keys.json");
    tokenProvider.mockReset();
    tokenProvider.mockResolvedValue("upstream-access-token");
    leaseSeq = 0;

    writeJson(accountsFilePath, {
      accounts: [
        { id: 1, email: "alpha@example.com", refreshToken: "rt-alpha", projectId: "proj-alpha", enabled: true },
      ],
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeService(resolverOrNull: any) {
    const resolver = new SessionTokenResolver(tokens, prisma as any);
    // Allow tests to override the real resolver with a mock
    const effectiveResolver = resolverOrNull === "real" ? resolver : resolverOrNull;

    const service = new TokenServerService({
      accountsFilePath,
      accessKeysFilePath,
      tokenProvider,
      now: () => Date.now(),
      randomId: () => `lease-${++leaseSeq}`,
      minClientVersion: "",
    });
    if (effectiveResolver !== null) {
      (service as any).accessKeyStore.setSessionResolver(effectiveResolver);
    }
    return service;
  }

  // ── (a) Session lease via real resolver + real DB ───────────────────────

  it("(a) session JWT → real DB resolver → shadow record → upstream token leased (viaSession)", async () => {
    const { customer, token } = await seedCustomerWithDevice();
    const sub = await seedSubscription(customer.id, { products: ["antigravity"] });
    writeShadowRecord(accessKeysFilePath, sub.id, sub.backingKeyValue);

    const service = makeService("real");

    const result = await service.leaseToken(
      { headers: { authorization: `Bearer ${token}` } },
      { clientId: "client-A", modelKey: "gemini-2.5-pro", bodyBytes: 500 },
    );

    expect(result.ok).toBe(true);
    expect(result.accessToken).toBe("upstream-access-token");
    expect(result.accessKeySessionId).toBe("sess:client-A");
    // viaSession path: no per-card lock minted
    const record = (service as any).accessKeyStore.findById(sub.id);
    expect(record).toBeTruthy();
    expect(record.activeSessionId).toBeUndefined();
  });

  // ── (b) report-result attribution to subscription.id ──────────────────

  it("(b) reportResult attributes usage to accessKeyId == subscription.id", async () => {
    const { customer, token } = await seedCustomerWithDevice();
    const sub = await seedSubscription(customer.id);
    writeShadowRecord(accessKeysFilePath, sub.id, sub.backingKeyValue);

    const service = makeService("real");

    const lease = await service.leaseToken(
      { headers: { authorization: `Bearer ${token}` } },
      { clientId: "client-A", modelKey: "gemini-2.5-pro", bodyBytes: 500 },
    );

    const report = await service.reportResult(
      { headers: { authorization: `Bearer ${token}` } },
      {
        leaseId: lease.leaseId,
        status: 200,
        modelKey: "gemini-2.5-pro",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
    );

    expect(report.ok).toBe(true);
    // Usage attributed to the shadow record whose id == sub.id
    const record = (service as any).accessKeyStore.findById(sub.id);
    expect(record.totalTokensUsed).toBe(150);
    expect(record.totalRequests).toBe(1);
    expect(report.accessKeyStatus).toBeDefined();
    expect(report.accessKeyStatus.totalTokensUsed).toBe(150);
  });

  // ── (c) Multi-device: two clientIds, same shadow record, no 409 ────────

  it("(c) two clientIds lease the same session subscription concurrently — no 409", async () => {
    const { customer, token } = await seedCustomerWithDevice();
    const sub = await seedSubscription(customer.id);
    writeShadowRecord(accessKeysFilePath, sub.id, sub.backingKeyValue);

    const service = makeService("real");

    const first = await service.leaseToken(
      { headers: { authorization: `Bearer ${token}` } },
      { clientId: "client-A", modelKey: "gemini-2.5-pro", bodyBytes: 500 },
    );
    const second = await service.leaseToken(
      { headers: { authorization: `Bearer ${token}` } },
      { clientId: "client-B", modelKey: "gemini-2.5-pro", bodyBytes: 500 },
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.accessKeySessionId).toBe("sess:client-A");
    expect(second.accessKeySessionId).toBe("sess:client-B");
    // No per-card single-session lock for session leases
    const record = (service as any).accessKeyStore.findById(sub.id);
    expect(record.activeSessionId).toBeUndefined();
  });

  // ── (c) Card regression: same card + second clientId → 409 ─────────────

  it("(c-card-regression) second clientId on a CARD key still gets 409", async () => {
    writeJson(accessKeysFilePath, {
      keys: [{ id: "card-1", key: "secret-card", status: "active", durationMs: 60_000, windowLimit: 100 }],
    });
    // No session resolver needed
    const service = makeService(null);

    await service.leaseToken(
      { headers: { "x-token-server-secret": "secret-card" } },
      { clientId: "client-A", modelKey: "gemini-2.5-pro", bodyBytes: 100 },
    );

    await expect(
      service.leaseToken(
        { headers: { "x-token-server-secret": "secret-card" } },
        { clientId: "client-B", modelKey: "gemini-2.5-pro", bodyBytes: 100 },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  // ── (d) Card path regression: legacy card key through dual-registered engine

  it("(d) card-key lease still works through the same (now alias-registered) engine", async () => {
    writeJson(accessKeysFilePath, {
      keys: [{
        id: "card-legacy",
        key: "legacy-secret",
        status: "active",
        durationMs: 60 * 60 * 1000,
        windowLimit: 50,
      }],
    });
    const service = makeService(null);

    const result = await service.leaseToken(
      { headers: { "x-token-server-secret": "legacy-secret" } },
      { clientId: "client-A", modelKey: "gemini-2.5-pro", bodyBytes: 500 },
    );

    expect(result.ok).toBe(true);
    expect(result.accessToken).toBe("upstream-access-token");
    // Card path: session lock was minted
    const record = (service as any).accessKeyStore.findById("card-legacy");
    expect(record.activeSessionId).toBeTruthy();
  });

  // ── (e) Rejection cases on the session path ─────────────────────────────

  it("(e) revoked device → DEVICE_REVOKED error in lease body", async () => {
    const { customer, token } = await seedCustomerWithDevice();
    const sub = await seedSubscription(customer.id);
    writeShadowRecord(accessKeysFilePath, sub.id, sub.backingKeyValue);
    // Revoke the device
    await prisma.device.updateMany({ where: { customerId: customer.id }, data: { status: "REVOKED" } });

    const service = makeService("real");

    await expect(
      service.leaseToken(
        { headers: { authorization: `Bearer ${token}` } },
        { clientId: "client-A", modelKey: "gemini-2.5-pro" },
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      body: { ok: false, error: "DEVICE_REVOKED" },
    });
  });

  it("(e) stale jti (re-login rotated session) → DEVICE_REVOKED", async () => {
    const { customer, token } = await seedCustomerWithDevice();
    const sub = await seedSubscription(customer.id);
    writeShadowRecord(accessKeysFilePath, sub.id, sub.backingKeyValue);
    await prisma.device.updateMany({ where: { customerId: customer.id }, data: { sessionJti: "rotated-jti" } });

    const service = makeService("real");

    await expect(
      service.leaseToken(
        { headers: { authorization: `Bearer ${token}` } },
        { clientId: "client-A", modelKey: "gemini-2.5-pro" },
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      body: { ok: false, error: "DEVICE_REVOKED" },
    });
  });

  it("(e) ACTIVE sub but EXPIRED shadow record (drift) → 403 SUBSCRIPTION_EXPIRED machine code", async () => {
    const { customer, token } = await seedCustomerWithDevice();
    const sub = await seedSubscription(customer.id, { expiresAt: new Date(Date.now() + 5 * DAY_MS) });
    // Shadow record with an absolute expiry already in the past
    writeShadowRecord(accessKeysFilePath, sub.id, sub.backingKeyValue, {
      keyExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const service = makeService("real");

    // M13a: record-level expiry on the session path carries the machine code —
    // the desktop client must see "renew subscription", not a generic 401.
    await expect(
      service.leaseToken(
        { headers: { authorization: `Bearer ${token}` } },
        { clientId: "client-A", modelKey: "gemini-2.5-pro" },
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      body: { ok: false, error: "SUBSCRIPTION_EXPIRED" },
    });
  });

  it("(e) expired/cancelled subscription (resolver returns SUBSCRIPTION_EXPIRED) → 403", async () => {
    const { customer, token } = await seedCustomerWithDevice();
    // Expired subscription
    const sub = await seedSubscription(customer.id, { expiresAt: new Date(Date.now() - 1000) });
    writeShadowRecord(accessKeysFilePath, sub.id, sub.backingKeyValue);

    const service = makeService("real");

    await expect(
      service.leaseToken(
        { headers: { authorization: `Bearer ${token}` } },
        { clientId: "client-A", modelKey: "gemini-2.5-pro" },
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      body: { ok: false, error: "SUBSCRIPTION_EXPIRED" },
    });
  });

  it("(e) web token (no deviceId claim) → SESSION_INVALID", async () => {
    const { customer } = await seedCustomerWithDevice();
    // Web token: no deviceId
    const webToken = tokens.sign({
      customerId: customer.id,
      email: customer.email,
      tokenVersion: customer.tokenVersion,
      // no deviceId
    });
    const sub = await seedSubscription(customer.id);
    writeShadowRecord(accessKeysFilePath, sub.id, sub.backingKeyValue);

    const service = makeService("real");

    await expect(
      service.leaseToken(
        { headers: { authorization: `Bearer ${webToken}` } },
        { clientId: "client-A", modelKey: "gemini-2.5-pro" },
      ),
    ).rejects.toMatchObject({
      statusCode: 401,
      body: { ok: false, error: "SESSION_INVALID" },
    });
  });
});

// ── Codex provider: alias + session resolver resolves for product=codex ──────

describe("M7 — codex alias metadata + session resolver coverage", () => {
  let tempDir: string;
  let accountsFilePath: string;
  let accessKeysFilePath: string;
  const tokenProvider = vi.fn();

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-m7-codex-"));
    accountsFilePath = path.join(tempDir, "codex-accounts.json");
    accessKeysFilePath = path.join(tempDir, "access-keys.json");
    tokenProvider.mockReset();
    tokenProvider.mockResolvedValue("codex-upstream-token");

    writeJson(accountsFilePath, {
      accounts: [
        { id: 10, email: "codex@example.com", refreshToken: "rt-codex", enabled: true, planType: "plus" },
      ],
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("codex controller path is 'app/lease/codex'", () => {
    expect(Reflect.getMetadata("path", RemoteCodexController)).toBe(
      "app/lease/codex",
    );
  });

  it("SessionTokenResolver resolves a codex subscription (product=codex)", async () => {
    const { customer, token } = await seedCustomerWithDevice("device-codex");
    await seedSubscription(customer.id, { products: ["codex"] });

    const resolver = new SessionTokenResolver(tokens, prisma as any);
    const result = await resolver.resolve(token, { product: "codex" });

    expect(result.ok).toBe(true);
  });

  it("session lease through RemoteCodexService resolves via session resolver + real engine", async () => {
    const { customer, token } = await seedCustomerWithDevice("device-codex-2");
    const sub = await seedSubscription(customer.id, { products: ["codex", "antigravity", "anthropic"] });
    writeShadowRecord(accessKeysFilePath, sub.id, sub.backingKeyValue);

    const service = new RemoteCodexService({
      accountsFilePath,
      accessKeysFilePath,
      tokenProvider,
      now: () => Date.now(),
      randomId: () => "codex-lease-1",
      minClientVersion: "",
    });
    const resolver = new SessionTokenResolver(tokens, prisma as any);
    (service as any).accessKeyStore.setSessionResolver(resolver);

    const result = await service.leaseToken(
      { headers: { authorization: `Bearer ${token}` } },
      { clientId: "client-codex", modelKey: "gpt-5-codex", bodyBytes: 200 },
    );

    expect(result.ok).toBe(true);
    expect(result.accessToken).toBe("codex-upstream-token");
    expect(result.accessKeySessionId).toBe("sess:client-codex");
  });
});

// ── Anthropic provider: alias + session resolver ────────────────────────────

describe("M7 — anthropic alias metadata + session resolver coverage", () => {
  let tempDir: string;
  let accountsFilePath: string;
  let accessKeysFilePath: string;
  const tokenProvider = vi.fn();

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-m7-anthropic-"));
    accountsFilePath = path.join(tempDir, "anthropic-accounts.json");
    accessKeysFilePath = path.join(tempDir, "access-keys.json");
    tokenProvider.mockReset();
    tokenProvider.mockResolvedValue("claude-upstream-token");

    writeJson(accountsFilePath, {
      accounts: [
        { id: 20, email: "claude@example.com", refreshToken: "rt-claude", enabled: true, planType: "pro" },
      ],
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("anthropic controller path is 'app/lease/anthropic'", () => {
    expect(Reflect.getMetadata("path", RemoteAnthropicController)).toBe(
      "app/lease/anthropic",
    );
  });

  it("SessionTokenResolver resolves an anthropic subscription (product=anthropic)", async () => {
    const { customer, token } = await seedCustomerWithDevice("device-anthropic");
    await seedSubscription(customer.id, { products: ["anthropic"] });

    const resolver = new SessionTokenResolver(tokens, prisma as any);
    const result = await resolver.resolve(token, { product: "anthropic" });

    expect(result.ok).toBe(true);
  });

  it("session lease through RemoteAnthropicService resolves via session resolver + real engine", async () => {
    const { customer, token } = await seedCustomerWithDevice("device-anthropic-2");
    const sub = await seedSubscription(customer.id, { products: ["codex", "antigravity", "anthropic"] });
    writeShadowRecord(accessKeysFilePath, sub.id, sub.backingKeyValue);

    const service = new RemoteAnthropicService({
      accountsFilePath,
      accessKeysFilePath,
      tokenProvider,
      now: () => Date.now(),
      randomId: () => "claude-lease-1",
      minClientVersion: "",
    });
    const resolver = new SessionTokenResolver(tokens, prisma as any);
    (service as any).accessKeyStore.setSessionResolver(resolver);

    const result = await service.leaseToken(
      { headers: { authorization: `Bearer ${token}` } },
      { clientId: "client-claude", modelKey: "claude-sonnet-4-6", bodyBytes: 200 },
    );

    expect(result.ok).toBe(true);
    expect(result.accessToken).toBe("claude-upstream-token");
    expect(result.accessKeySessionId).toBe("sess:client-claude");
  });
});
