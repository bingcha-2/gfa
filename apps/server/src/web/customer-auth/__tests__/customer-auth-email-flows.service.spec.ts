/**
 * customer-auth-email-flows.service.spec.ts
 *
 * Tests for the new email-based flows in CustomerAuthService (M3):
 *   3. forgot-password: unknown email → {ok:true}, no token, no mail;
 *                       known email → token row + mail invoked with plaintext link
 *   4. reset-password: happy path changes password + bumps tokenVersion;
 *                      INVALID_TOKEN on bad/expired/reused
 *   5. verify-email: flips emailVerified; token single-use
 *   6. request-verify-email: alreadyVerified guard; issues token + sends mail
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { createHash } from "node:crypto";
import { CustomerEmailTokenPurpose } from "@prisma/client";

import { CustomerAuthService } from "../customer-auth.service";
import { CustomerTokenService } from "../customer-token.service";
import { CustomerEmailTokenService } from "../customer-email-token.service";
import { JwtService } from "@nestjs/jwt";

// ── helpers ──────────────────────────────────────────────────────────────────

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

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

function makeEmailToken(overrides: Partial<{
  id: string;
  customerId: string;
  tokenHash: string;
  purpose: CustomerEmailTokenPurpose;
  expiresAt: Date;
  usedAt: Date | null;
}> = {}) {
  return {
    id: overrides.id ?? "etok-1",
    customerId: overrides.customerId ?? "cust-1",
    tokenHash: overrides.tokenHash ?? "hash",
    purpose: overrides.purpose ?? CustomerEmailTokenPurpose.VERIFY_EMAIL,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
    usedAt: overrides.usedAt ?? null,
    createdAt: new Date()
  };
}

/**
 * Build all three services with shared in-memory stores.
 */
function makeServices(
  customerStore: ReturnType<typeof makeCustomer>[] = [],
  tokenStore: ReturnType<typeof makeEmailToken>[] = []
) {
  const prisma = {
    customer: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.email) return customerStore.find(c => c.email === where.email) ?? null;
        if (where.id) return customerStore.find(c => c.id === where.id) ?? null;
        if (where.referralCode) return customerStore.find(c => c.referralCode === where.referralCode) ?? null;
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
        const current = customerStore[idx];
        const updated = {
          ...current,
          ...(data.passwordHash !== undefined ? { passwordHash: data.passwordHash } : {}),
          ...(data.emailVerified !== undefined ? { emailVerified: data.emailVerified } : {}),
          ...(data.displayName !== undefined ? { displayName: data.displayName } : {}),
          tokenVersion: data.tokenVersion?.increment != null
            ? current.tokenVersion + data.tokenVersion.increment
            : (data.tokenVersion ?? current.tokenVersion)
        };
        customerStore[idx] = updated;
        return updated;
      })
    },
    customerEmailToken: {
      create: vi.fn(async ({ data }: any) => {
        const token = makeEmailToken({
          id: `etok-${Date.now()}-${Math.random()}`,
          customerId: data.customerId,
          tokenHash: data.tokenHash,
          purpose: data.purpose,
          expiresAt: data.expiresAt,
          usedAt: null
        });
        tokenStore.push(token);
        return token;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.tokenHash) {
          return tokenStore.find(t => t.tokenHash === where.tokenHash) ?? null;
        }
        return null;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const matches = tokenStore.filter(t => {
          if (where.tokenHash && t.tokenHash !== where.tokenHash) return false;
          if (where.purpose && t.purpose !== where.purpose) return false;
          if (where.usedAt === null && t.usedAt !== null) return false;
          if (where.expiresAt?.gt && t.expiresAt <= where.expiresAt.gt) return false;
          return true;
        });
        for (const t of matches) {
          if (data.usedAt !== undefined) t.usedAt = data.usedAt;
        }
        return { count: matches.length };
      })
    }
  };

  process.env.CUSTOMER_JWT_SECRET = "test-customer-secret-that-is-32-chars-long!!";

  const jwtService = new JwtService({});
  const tokenService = new CustomerTokenService(jwtService);
  const emailTokenService = new CustomerEmailTokenService(prisma as any);

  const mailService = {
    sendMail: vi.fn(async () => ({ ok: true }))
  };

  const service = new CustomerAuthService(
    prisma as any,
    tokenService,
    emailTokenService,
    mailService as any
  );

  return { service, tokenService, emailTokenService, mailService, prisma, customerStore, tokenStore };
}

// ── 3. forgot-password ────────────────────────────────────────────────────────

describe("CustomerAuthService.forgotPassword", () => {
  beforeEach(() => {
    process.env.CUSTOMER_JWT_SECRET = "test-customer-secret-that-is-32-chars-long!!";
    process.env.WEB_BASE_URL = "https://bcai.lol";
  });

  it("unknown email → {ok:true} and no token created", async () => {
    const { service, tokenStore } = makeServices();

    const result = await service.forgotPassword("nobody@test.com");

    expect(result).toEqual({ ok: true });
    expect(tokenStore).toHaveLength(0);
  });

  it("unknown email → no mail sent", async () => {
    const { service, mailService, tokenStore } = makeServices();

    await service.forgotPassword("nobody@test.com");

    expect(mailService.sendMail).not.toHaveBeenCalled();
    expect(tokenStore).toHaveLength(0);
  });

  it("known email → creates a RESET_PASSWORD token row", async () => {
    const customer = makeCustomer({ email: "user@test.com" });
    const { service, tokenStore } = makeServices([customer]);

    await service.forgotPassword("user@test.com");

    expect(tokenStore).toHaveLength(1);
    expect(tokenStore[0].purpose).toBe(CustomerEmailTokenPurpose.RESET_PASSWORD);
    expect(tokenStore[0].customerId).toBe(customer.id);
  });

  it("known email → token hash in DB is not the plaintext", async () => {
    const customer = makeCustomer({ email: "user@test.com" });
    const { service, tokenStore, mailService } = makeServices([customer]);

    await service.forgotPassword("user@test.com");

    // Extract the plaintext from the link sent in the mail
    const callArg = mailService.sendMail.mock.calls[0][0];
    const url = new URL(callArg.text.match(/https?:\/\/[^\s]+/)[0]);
    const plaintext = url.searchParams.get("token")!;

    expect(tokenStore[0].tokenHash).toBe(sha256(plaintext));
    expect(tokenStore[0].tokenHash).not.toBe(plaintext);
  });

  it("known email → sends mail with link containing the plaintext token", async () => {
    const customer = makeCustomer({ email: "user@test.com" });
    const { service, mailService } = makeServices([customer]);

    await service.forgotPassword("user@test.com");

    expect(mailService.sendMail).toHaveBeenCalledOnce();
    const callArg = mailService.sendMail.mock.calls[0][0];
    expect(callArg.to).toBe("user@test.com");
    expect(callArg.text).toContain("/app/reset?token=");
    expect(callArg.text).toContain("https://bcai.lol");
  });

  it("known email → token has 30min expiry", async () => {
    const customer = makeCustomer({ email: "user@test.com" });
    const { service, tokenStore } = makeServices([customer]);

    const before = Date.now();
    await service.forgotPassword("user@test.com");
    const after = Date.now();

    const expiresAt = tokenStore[0].expiresAt.getTime();
    const thirtyMin = 30 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(before + thirtyMin - 100);
    expect(expiresAt).toBeLessThanOrEqual(after + thirtyMin + 100);
  });
});

// ── 4. reset-password ─────────────────────────────────────────────────────────

describe("CustomerAuthService.resetPassword", () => {
  beforeEach(() => {
    process.env.CUSTOMER_JWT_SECRET = "test-customer-secret-that-is-32-chars-long!!";
  });

  it("happy path: changes password and bumps tokenVersion", async () => {
    const hash = await bcrypt.hash("oldpass123", 10);
    const customer = makeCustomer({
      email: "user@test.com",
      passwordHash: hash,
      tokenVersion: 0
    });

    // Build shared stores so a single service instance can both issue and consume
    const customerStore = [customer];
    const tokenStore: ReturnType<typeof makeEmailToken>[] = [];
    const { service, emailTokenService, customerStore: svcCustomerStore } =
      makeServices(customerStore, tokenStore);

    // Issue a real RESET_PASSWORD token via the email token service
    const plaintext = await emailTokenService.issueToken(
      customer.id,
      CustomerEmailTokenPurpose.RESET_PASSWORD,
      30 * 60 * 1000
    );

    const result = await service.resetPassword(plaintext, "newpassword1");
    expect(result).toEqual({ ok: true });

    // New password must work
    const newHash = svcCustomerStore[0].passwordHash;
    expect(await bcrypt.compare("newpassword1", newHash)).toBe(true);
    // Old password must no longer work
    expect(await bcrypt.compare("oldpass123", newHash)).toBe(false);
    // tokenVersion must be bumped
    expect(svcCustomerStore[0].tokenVersion).toBe(1);
  });

  it("invalid/nonexistent token → 400 INVALID_TOKEN", async () => {
    const { service } = makeServices();

    await expect(
      service.resetPassword("aaaa" + "x".repeat(60), "newpassword1")
    ).rejects.toThrow(BadRequestException);

    try {
      await service.resetPassword("aaaa" + "x".repeat(60), "newpassword1");
    } catch (err: any) {
      expect(err.response?.error).toBe("INVALID_TOKEN");
    }
  });

  it("token with wrong purpose → 400 INVALID_TOKEN", async () => {
    const customer = makeCustomer({ email: "user@test.com" });
    const tokenStore: ReturnType<typeof makeEmailToken>[] = [];

    // Create a VERIFY_EMAIL token instead of RESET_PASSWORD
    const { emailTokenService } = makeServices([customer], tokenStore);
    const plaintext = await emailTokenService.issueToken(
      customer.id,
      CustomerEmailTokenPurpose.VERIFY_EMAIL, // wrong purpose
      30 * 60 * 1000
    );

    const { service } = makeServices([customer], tokenStore);

    await expect(
      service.resetPassword(plaintext, "newpassword1")
    ).rejects.toThrow(BadRequestException);
  });

  it("expired token → 400 INVALID_TOKEN", async () => {
    const customer = makeCustomer({ email: "user@test.com" });
    const tokenStore = [
      makeEmailToken({
        customerId: customer.id,
        tokenHash: sha256("expiredtoken" + "x".repeat(52)),
        purpose: CustomerEmailTokenPurpose.RESET_PASSWORD,
        expiresAt: new Date(Date.now() - 1000) // expired
      })
    ];
    const { service } = makeServices([customer], tokenStore);

    await expect(
      service.resetPassword("expiredtoken" + "x".repeat(52), "newpassword1")
    ).rejects.toThrow(BadRequestException);
  });

  it("already-used token → 400 INVALID_TOKEN", async () => {
    const customer = makeCustomer({ email: "user@test.com" });
    const tokenStore: ReturnType<typeof makeEmailToken>[] = [];
    const { emailTokenService } = makeServices([customer], tokenStore);
    const plaintext = await emailTokenService.issueToken(
      customer.id,
      CustomerEmailTokenPurpose.RESET_PASSWORD,
      30 * 60 * 1000
    );

    const { service } = makeServices([customer], tokenStore);

    // First use — ok
    await service.resetPassword(plaintext, "newpassword1");

    // Second use — should fail with INVALID_TOKEN
    await expect(
      service.resetPassword(plaintext, "newpassword2")
    ).rejects.toThrow(BadRequestException);
  });
});

// ── 5. verify-email ───────────────────────────────────────────────────────────

describe("CustomerAuthService.verifyEmail", () => {
  it("flips emailVerified to true", async () => {
    const customer = makeCustomer({ emailVerified: false });
    const tokenStore: ReturnType<typeof makeEmailToken>[] = [];
    const { emailTokenService } = makeServices([customer], tokenStore);
    const plaintext = await emailTokenService.issueToken(
      customer.id,
      CustomerEmailTokenPurpose.VERIFY_EMAIL,
      24 * 60 * 60 * 1000
    );

    const { service, customerStore } = makeServices([customer], tokenStore);
    const result = await service.verifyEmail(plaintext);

    expect(result).toEqual({ ok: true });
    expect(customerStore[0].emailVerified).toBe(true);
  });

  it("second use of same token → 400 INVALID_TOKEN", async () => {
    const customer = makeCustomer({ emailVerified: false });
    const tokenStore: ReturnType<typeof makeEmailToken>[] = [];
    const { emailTokenService } = makeServices([customer], tokenStore);
    const plaintext = await emailTokenService.issueToken(
      customer.id,
      CustomerEmailTokenPurpose.VERIFY_EMAIL,
      24 * 60 * 60 * 1000
    );

    const { service } = makeServices([customer], tokenStore);

    await service.verifyEmail(plaintext);

    await expect(
      service.verifyEmail(plaintext)
    ).rejects.toThrow(BadRequestException);
  });

  it("invalid token → 400 INVALID_TOKEN", async () => {
    const { service } = makeServices();

    await expect(
      service.verifyEmail("nosuchtoken" + "x".repeat(53))
    ).rejects.toThrow(BadRequestException);

    try {
      await service.verifyEmail("nosuchtoken" + "x".repeat(53));
    } catch (err: any) {
      expect(err.response?.error).toBe("INVALID_TOKEN");
    }
  });
});

// ── 6. request-verify-email ───────────────────────────────────────────────────

describe("CustomerAuthService.requestVerifyEmail", () => {
  beforeEach(() => {
    process.env.WEB_BASE_URL = "https://bcai.lol";
  });

  it("already verified → {ok:true, alreadyVerified:true}, no token, no mail", async () => {
    const customer = makeCustomer({ emailVerified: true });
    const { service, tokenStore, mailService } = makeServices([customer]);

    const result = await service.requestVerifyEmail(customer.id);

    expect(result).toEqual({ ok: true, alreadyVerified: true });
    expect(tokenStore).toHaveLength(0);
    expect(mailService.sendMail).not.toHaveBeenCalled();
  });

  it("not yet verified → issues VERIFY_EMAIL token", async () => {
    const customer = makeCustomer({ emailVerified: false });
    const { service, tokenStore } = makeServices([customer]);

    await service.requestVerifyEmail(customer.id);

    expect(tokenStore).toHaveLength(1);
    expect(tokenStore[0].purpose).toBe(CustomerEmailTokenPurpose.VERIFY_EMAIL);
  });

  it("not yet verified → sends mail with verify link", async () => {
    const customer = makeCustomer({ email: "user@test.com", emailVerified: false });
    const { service, mailService } = makeServices([customer]);

    await service.requestVerifyEmail(customer.id);

    expect(mailService.sendMail).toHaveBeenCalledOnce();
    const callArg = mailService.sendMail.mock.calls[0][0];
    expect(callArg.to).toBe("user@test.com");
    expect(callArg.text).toContain("/app/verify-email?token=");
  });

  it("verify link token matches the issued token (hash check)", async () => {
    const customer = makeCustomer({ email: "user@test.com", emailVerified: false });
    const { service, tokenStore, mailService } = makeServices([customer]);

    await service.requestVerifyEmail(customer.id);

    const callArg = mailService.sendMail.mock.calls[0][0];
    const urlMatch = callArg.text.match(/https?:\/\/[^\s]+/);
    expect(urlMatch).not.toBeNull();
    const url = new URL(urlMatch[0]);
    const plaintext = url.searchParams.get("token")!;

    expect(tokenStore[0].tokenHash).toBe(sha256(plaintext));
  });

  it("not yet verified → returns {ok:true}", async () => {
    const customer = makeCustomer({ emailVerified: false });
    const { service } = makeServices([customer]);

    const result = await service.requestVerifyEmail(customer.id);

    expect(result).toEqual({ ok: true });
  });
});

// ── registration auto-verification ───────────────────────────────────────────

describe("CustomerAuthService.register — auto-sends verification email", () => {
  beforeEach(() => {
    process.env.CUSTOMER_JWT_SECRET = "test-customer-secret-that-is-32-chars-long!!";
    process.env.WEB_BASE_URL = "https://bcai.lol";
  });

  it("registration succeeds even if mail send fails", async () => {
    const { service, mailService } = makeServices();
    mailService.sendMail.mockResolvedValueOnce({ ok: false });

    const result = await service.register({
      email: "newuser@test.com",
      password: "mypassword123"
    });

    expect(result.accessToken).toBeDefined();
    expect(result.customer.email).toBe("newuser@test.com");
  });

  it("registration triggers a VERIFY_EMAIL token + mail", async () => {
    const { service, mailService, tokenStore } = makeServices();

    await service.register({
      email: "newuser@test.com",
      password: "mypassword123"
    });

    // Give best-effort async fire-and-forget a tick to settle
    await new Promise(resolve => setImmediate(resolve));

    expect(tokenStore.length).toBeGreaterThanOrEqual(1);
    const emailToken = tokenStore.find(t => t.purpose === CustomerEmailTokenPurpose.VERIFY_EMAIL);
    expect(emailToken).toBeDefined();
    expect(mailService.sendMail).toHaveBeenCalledOnce();
  });
});
