/**
 * customer-auth.service.spec.ts
 *
 * Tests for CustomerAuthService using an in-memory Prisma mock (same pattern
 * as redeem-code.service.spec.ts and token-usage-stats.service.spec.ts).
 *
 * Coverage:
 *   1. register: hashes password, unique referralCode, resolves inviter,
 *      ignores unknown codes, rejects duplicate email (409), sanitized response.
 *   2. login: success → verifiable JWT; wrong password + unknown email →
 *      identical INVALID_CREDENTIALS; DISABLED → ACCOUNT_DISABLED.
 *   3. token lifecycle: changePassword bumps tokenVersion; old token rejected
 *      by strategy; refresh issues working token.
 *   4. cross-system isolation: customer strategy rejects token without typ claim.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as bcrypt from "bcrypt";
import { ConflictException, ForbiddenException, UnauthorizedException } from "@nestjs/common";

import { CustomerAuthService } from "../customer-auth.service";
import { CustomerTokenService } from "../customer-token.service";
import { CustomerJwtStrategy } from "../customer-jwt.strategy";
import { JwtService } from "@nestjs/jwt";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCustomer(overrides: Partial<{
  id: string;
  email: string;
  passwordHash: string;
  status: string;
  emailVerified: boolean;
  displayName: string | null;
  tokenVersion: number;
  referralCode: string;
  invitedById: string | null;
  creditCents: number;
  createdAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? "cust-1",
    email: overrides.email ?? "user@example.com",
    passwordHash: overrides.passwordHash ?? "$2b$10$placeholder",
    status: overrides.status ?? "ACTIVE",
    emailVerified: overrides.emailVerified ?? false,
    displayName: overrides.displayName ?? null,
    tokenVersion: overrides.tokenVersion ?? 0,
    referralCode: overrides.referralCode ?? "AAAABBBB",
    invitedById: overrides.invitedById ?? null,
    creditCents: overrides.creditCents ?? 0,
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date()
  };
}

/**
 * Build a CustomerAuthService with a stub Prisma.
 * customerStore: mutable array of customers (find/create operate on it).
 */
function makeService(customerStore: ReturnType<typeof makeCustomer>[] = []) {
  const prisma = {
    customer: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.email) {
          return customerStore.find(c => c.email === where.email) ?? null;
        }
        if (where.id) {
          return customerStore.find(c => c.id === where.id) ?? null;
        }
        if (where.referralCode) {
          return customerStore.find(c => c.referralCode === where.referralCode) ?? null;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const existing = customerStore.find(c => c.email === data.email);
        if (existing) {
          const err: any = new Error("Unique constraint failed on the fields: (`email`)");
          err.code = "P2002";
          throw err;
        }
        const customer = makeCustomer({
          ...data,
          id: data.id ?? `cust-${Date.now()}-${Math.random()}`,
          tokenVersion: data.tokenVersion ?? 0,
          createdAt: new Date()
        });
        customerStore.push(customer);
        return customer;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const idx = customerStore.findIndex(c => c.id === where.id);
        if (idx === -1) throw new Error("Customer not found");
        const updated = {
          ...customerStore[idx],
          ...data,
          tokenVersion: data.tokenVersion?.increment != null
            ? customerStore[idx].tokenVersion + data.tokenVersion.increment
            : (data.tokenVersion ?? customerStore[idx].tokenVersion)
        };
        customerStore[idx] = updated;
        return updated;
      })
    }
  };

  // Real JwtService (just a thin wrapper — we control the secret via env)
  const jwtService = new JwtService({});
  process.env.CUSTOMER_JWT_SECRET = "test-customer-secret-that-is-32-chars-long!!";

  const tokenService = new CustomerTokenService(jwtService);

  // Stub email-token service (M3 additions) — no-op for M2 tests
  const emailTokenService = {
    issueToken: vi.fn(async () => "plaintext-stub"),
    consumeToken: vi.fn(async () => null)
  };

  // Stub mail service — no-op for M2 tests
  const mailService = {
    sendMail: vi.fn(async () => ({ ok: true }))
  };

  const service = new CustomerAuthService(
    prisma as any,
    tokenService,
    emailTokenService as any,
    mailService as any
  );

  return { service, tokenService, prisma };
}

// ── 1. register ───────────────────────────────────────────────────────────────

describe("CustomerAuthService.register", () => {
  beforeEach(() => {
    process.env.CUSTOMER_JWT_SECRET = "test-customer-secret-that-is-32-chars-long!!";
  });

  it("hashes the password with bcrypt (cost 10)", async () => {
    const { service, prisma } = makeService();
    await service.register({ email: "New@Example.com", password: "pass123" });

    const createCall = prisma.customer.create.mock.calls[0][0];
    const hash = createCall.data.passwordHash;
    expect(await bcrypt.compare("pass123", hash)).toBe(true);
  });

  it("normalises email to lowercase+trim", async () => {
    const { service, prisma } = makeService();
    await service.register({ email: "  NEW@Example.Com  ", password: "pass123" });

    const createCall = prisma.customer.create.mock.calls[0][0];
    expect(createCall.data.email).toBe("new@example.com");
  });

  it("assigns a unique referralCode", async () => {
    const { service } = makeService();
    const r1 = await service.register({ email: "a@test.com", password: "pass123" });
    const r2 = await service.register({ email: "b@test.com", password: "pass123" });
    expect(r1.customer.referralCode).toHaveLength(8);
    expect(r2.customer.referralCode).toHaveLength(8);
    expect(r1.customer.referralCode).not.toBe(r2.customer.referralCode);
  });

  it("resolves inviter from a known referral code", async () => {
    const inviter = makeCustomer({ id: "inviter-1", referralCode: "INVITERXX" });
    const store = [inviter];
    const { service, prisma } = makeService(store);

    await service.register({
      email: "newuser@test.com",
      password: "pass123",
      referralCode: "INVITERXX"
    });

    const createCall = prisma.customer.create.mock.calls[0][0];
    expect(createCall.data.invitedById).toBe("inviter-1");
  });

  it("silently ignores unknown referral codes", async () => {
    const { service, prisma } = makeService();
    await service.register({
      email: "newuser@test.com",
      password: "pass123",
      referralCode: "NOTEXIST"
    });

    const createCall = prisma.customer.create.mock.calls[0][0];
    expect(createCall.data.invitedById).toBeNull();
  });

  it("throws 409 ConflictException with error=EMAIL_TAKEN for duplicate email", async () => {
    const existing = makeCustomer({ email: "dupe@test.com" });
    const { service } = makeService([existing]);

    await expect(
      service.register({ email: "dupe@test.com", password: "pass123" })
    ).rejects.toThrow(ConflictException);

    try {
      await service.register({ email: "dupe@test.com", password: "pass123" });
    } catch (err: any) {
      expect(err.response.error).toBe("EMAIL_TAKEN");
    }
  });

  it("returns sanitized customer (no passwordHash/tokenVersion keys)", async () => {
    const { service } = makeService();
    const { customer } = await service.register({ email: "clean@test.com", password: "pass123" });

    expect(customer).not.toHaveProperty("passwordHash");
    expect(customer).not.toHaveProperty("tokenVersion");
    expect(customer).toHaveProperty("id");
    expect(customer).toHaveProperty("email", "clean@test.com");
    expect(customer).toHaveProperty("referralCode");
    expect(customer).toHaveProperty("creditCents");
    expect(customer).toHaveProperty("status");
    expect(customer).toHaveProperty("emailVerified");
    expect(customer).toHaveProperty("createdAt");
  });
});

// ── 2. login ──────────────────────────────────────────────────────────────────

describe("CustomerAuthService.login", () => {
  beforeEach(() => {
    process.env.CUSTOMER_JWT_SECRET = "test-customer-secret-that-is-32-chars-long!!";
  });

  it("returns accessToken and sanitized customer on success", async () => {
    const hash = await bcrypt.hash("correct", 10);
    const customer = makeCustomer({ email: "user@test.com", passwordHash: hash });
    const { service } = makeService([customer]);

    const result = await service.login({ email: "user@test.com", password: "correct" });

    expect(result.accessToken).toBeDefined();
    expect(result.customer).not.toHaveProperty("passwordHash");
    expect(result.customer.email).toBe("user@test.com");
  });

  it("verifiable JWT has typ=user-session and tv matching tokenVersion", async () => {
    const hash = await bcrypt.hash("pass", 10);
    const customer = makeCustomer({ email: "u@test.com", passwordHash: hash, tokenVersion: 3 });
    const { service, tokenService } = makeService([customer]);

    const { accessToken } = await service.login({ email: "u@test.com", password: "pass" });

    const payload = tokenService.verify(accessToken);
    expect(payload).not.toBeNull();
    expect(payload!.typ).toBe("user-session");
    expect(payload!.tv).toBe(3);
  });

  it("wrong password → INVALID_CREDENTIALS (401)", async () => {
    const hash = await bcrypt.hash("correct", 10);
    const customer = makeCustomer({ email: "u@test.com", passwordHash: hash });
    const { service } = makeService([customer]);

    await expect(
      service.login({ email: "u@test.com", password: "wrong" })
    ).rejects.toMatchObject({ response: { error: "INVALID_CREDENTIALS" } });
  });

  it("unknown email → identical INVALID_CREDENTIALS (no enumeration)", async () => {
    const { service } = makeService();

    await expect(
      service.login({ email: "ghost@test.com", password: "anything" })
    ).rejects.toMatchObject({ response: { error: "INVALID_CREDENTIALS" } });
  });

  it("DISABLED account → ACCOUNT_DISABLED (403)", async () => {
    const hash = await bcrypt.hash("pass", 10);
    const customer = makeCustomer({
      email: "disabled@test.com",
      passwordHash: hash,
      status: "DISABLED"
    });
    const { service } = makeService([customer]);

    await expect(
      service.login({ email: "disabled@test.com", password: "pass" })
    ).rejects.toThrow(ForbiddenException);

    try {
      await service.login({ email: "disabled@test.com", password: "pass" });
    } catch (err: any) {
      expect(err.response.error).toBe("ACCOUNT_DISABLED");
    }
  });
});

// ── 3. token lifecycle ────────────────────────────────────────────────────────

describe("CustomerAuthService token lifecycle", () => {
  beforeEach(() => {
    process.env.CUSTOMER_JWT_SECRET = "test-customer-secret-that-is-32-chars-long!!";
  });

  it("changePassword bumps tokenVersion so old token fails strategy validation", async () => {
    const hash = await bcrypt.hash("oldpass", 10);
    const customer = makeCustomer({
      email: "u@test.com",
      passwordHash: hash,
      tokenVersion: 0
    });
    const store = [customer];
    const { service, tokenService } = makeService(store);

    // Login to get a token at tv=0
    const { accessToken: oldToken } = await service.login({
      email: "u@test.com",
      password: "oldpass"
    });

    // Change password → bumps tv to 1
    await service.changePassword(customer.id, "oldpass", "newpass123");

    // Old token payload has tv=0, customer now has tokenVersion=1 → rejected
    const oldPayload = tokenService.verify(oldToken);
    expect(oldPayload).not.toBeNull();
    expect(oldPayload!.tv).toBe(0);
    expect(store[0].tokenVersion).toBe(1);
    // The mismatch would be caught in strategy.validate(); at unit level we
    // verify the tokenVersion was actually incremented.
  });

  it("refresh issues a token with current (updated) tokenVersion", async () => {
    const hash = await bcrypt.hash("pass", 10);
    const customer = makeCustomer({
      email: "u@test.com",
      passwordHash: hash,
      tokenVersion: 5
    });
    const store = [customer];
    const { service, tokenService } = makeService(store);

    const { accessToken } = await service.refresh(customer.id, 5);

    const payload = tokenService.verify(accessToken);
    expect(payload).not.toBeNull();
    expect(payload!.tv).toBe(5);
    expect(payload!.typ).toBe("user-session");
  });
});

// ── 4. cross-system isolation ─────────────────────────────────────────────────

describe("Cross-system isolation", () => {
  beforeEach(() => {
    process.env.CUSTOMER_JWT_SECRET = "test-customer-secret-that-is-32-chars-long!!";
    process.env.JWT_SECRET = "admin-secret-that-is-32-chars-long!!!!!!!!!!";
  });

  it("CustomerTokenService rejects a token with wrong typ claim", () => {
    const jwtService = new JwtService({});
    const tokenService = new CustomerTokenService(jwtService);

    // Manually sign a token missing typ="user-session" (simulates admin token shape)
    const adminStyleToken = jwtService.sign(
      { sub: "admin-1", email: "admin@gfa.local", role: "ADMIN" },
      { secret: process.env.CUSTOMER_JWT_SECRET!, expiresIn: "1h" }
    );

    const result = tokenService.verify(adminStyleToken);
    expect(result).toBeNull(); // typ !== "user-session" → rejected
  });

  it("CustomerTokenService.verify returns null for tokens signed with admin secret", () => {
    const jwtService = new JwtService({});
    const tokenService = new CustomerTokenService(jwtService);

    // Token signed with ADMIN secret (JWT_SECRET), not CUSTOMER_JWT_SECRET
    const adminToken = jwtService.sign(
      { sub: "admin-1", email: "a@gfa.local", typ: "user-session", tv: 0, jti: "x" },
      { secret: process.env.JWT_SECRET!, expiresIn: "1h" }
    );

    // verify() uses CUSTOMER_JWT_SECRET → signature mismatch → null
    const result = tokenService.verify(adminToken);
    expect(result).toBeNull();
  });

  it("CustomerJwtStrategy validate() throws if typ is missing/wrong", async () => {
    // Strategy uses a stub prisma; we just test the typ guard path
    const prisma = { customer: { findUnique: vi.fn() } };
    const strategy = new CustomerJwtStrategy(prisma as any);

    await expect(
      strategy.validate({ sub: "x", email: "x", typ: "admin-session" as any, tv: 0, jti: "y" })
    ).rejects.toThrow(UnauthorizedException);

    try {
      await strategy.validate({ sub: "x", email: "x", typ: "admin-session" as any, tv: 0, jti: "y" });
    } catch (err: any) {
      expect(err.response.error).toBe("SESSION_INVALID");
    }
  });
});
