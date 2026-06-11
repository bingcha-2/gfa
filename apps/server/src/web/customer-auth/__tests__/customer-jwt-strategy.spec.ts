/**
 * customer-jwt-strategy.spec.ts
 *
 * Focused unit tests for CustomerJwtStrategy.validate().
 * Covers:
 *   - tokenVersion mismatch (revocation path): tv in JWT != customer.tokenVersion → 401 SESSION_INVALID
 *   - typ mismatch: wrong typ claim → 401 SESSION_INVALID
 *   - account disabled: status != ACTIVE → 401 SESSION_INVALID
 *   - customer not found: → 401 SESSION_INVALID
 *   - happy path: valid payload returns CustomerUser
 */

import { describe, it, expect, vi } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import { CustomerJwtStrategy } from "../customer-jwt.strategy";
import type { CustomerJwtPayload } from "../customer-token.service";

function makeStrategy(customers: any[]) {
  const prisma = {
    customer: {
      findUnique: vi.fn(async ({ where }: any) => {
        return customers.find(c => c.id === where.id) ?? null;
      })
    }
  };
  return new CustomerJwtStrategy(prisma as any);
}

function makePayload(overrides: Partial<CustomerJwtPayload> = {}): CustomerJwtPayload {
  return {
    sub: "cust-1",
    email: "user@test.com",
    typ: "user-session",
    tv: 0,
    jti: "jti-abc",
    ...overrides
  };
}

function makeCustomer(overrides: any = {}) {
  return {
    id: overrides.id ?? "cust-1",
    email: overrides.email ?? "user@test.com",
    status: overrides.status ?? "ACTIVE",
    tokenVersion: overrides.tokenVersion ?? 0,
    ...overrides
  };
}

// ── tokenVersion revocation ───────────────────────────────────────────────────

describe("CustomerJwtStrategy.validate() — tokenVersion revocation", () => {
  it("tv in JWT does NOT match customer.tokenVersion → throws SESSION_INVALID (401)", async () => {
    // Customer has tokenVersion 1 (password was reset/changed), but JWT has tv=0
    const strategy = makeStrategy([makeCustomer({ tokenVersion: 1 })]);
    const payload = makePayload({ tv: 0 }); // stale token

    await expect(strategy.validate(payload)).rejects.toThrow(UnauthorizedException);

    try {
      await strategy.validate(payload);
    } catch (err: any) {
      expect(err.response?.error).toBe("SESSION_INVALID");
      expect(err.response?.message).toBe("Session has been revoked");
    }
  });

  it("tv matches customer.tokenVersion → validation succeeds", async () => {
    const strategy = makeStrategy([makeCustomer({ tokenVersion: 3 })]);
    const payload = makePayload({ tv: 3 });

    await expect(strategy.validate(payload)).resolves.toMatchObject({
      customerId: "cust-1",
      email: "user@test.com"
    });
  });
});

// ── typ mismatch ──────────────────────────────────────────────────────────────

describe("CustomerJwtStrategy.validate() — typ mismatch", () => {
  it("wrong typ claim → throws SESSION_INVALID", async () => {
    const strategy = makeStrategy([makeCustomer()]);
    const payload = makePayload({ typ: "admin-session" as any });

    await expect(strategy.validate(payload)).rejects.toThrow(UnauthorizedException);

    try {
      await strategy.validate(payload);
    } catch (err: any) {
      expect(err.response?.error).toBe("SESSION_INVALID");
    }
  });
});

// ── customer not found ────────────────────────────────────────────────────────

describe("CustomerJwtStrategy.validate() — customer not found", () => {
  it("customer not in DB → throws SESSION_INVALID", async () => {
    const strategy = makeStrategy([]);
    const payload = makePayload({ sub: "ghost-id" });

    await expect(strategy.validate(payload)).rejects.toThrow(UnauthorizedException);
  });
});

// ── account disabled ──────────────────────────────────────────────────────────

describe("CustomerJwtStrategy.validate() — account disabled", () => {
  it("status DISABLED → throws SESSION_INVALID", async () => {
    const strategy = makeStrategy([makeCustomer({ status: "DISABLED" })]);
    const payload = makePayload();

    await expect(strategy.validate(payload)).rejects.toThrow(UnauthorizedException);

    try {
      await strategy.validate(payload);
    } catch (err: any) {
      expect(err.response?.error).toBe("SESSION_INVALID");
    }
  });
});
