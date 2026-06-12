/**
 * customer-email-token.service.spec.ts
 *
 * Prisma-backed tests for CustomerEmailTokenService.
 * Coverage:
 *   1. issueToken: stores only sha256 hash (plaintext nowhere in DB), correct purpose/expiry.
 *   2. consumeToken: success marks usedAt; second consume fails; expired token fails;
 *      wrong purpose fails; nonexistent token returns null.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { CustomerEmailTokenPurpose } from "@prisma/client";
import { CustomerEmailTokenService } from "../customer-email-token.service";

// ── helpers ──────────────────────────────────────────────────────────────────

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function makeToken(overrides: Partial<{
  id: string;
  customerId: string;
  tokenHash: string;
  purpose: CustomerEmailTokenPurpose;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? "tok-1",
    customerId: overrides.customerId ?? "cust-1",
    tokenHash: overrides.tokenHash ?? "deadbeef",
    purpose: overrides.purpose ?? CustomerEmailTokenPurpose.VERIFY_EMAIL,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
    usedAt: overrides.usedAt ?? null,
    createdAt: overrides.createdAt ?? new Date()
  };
}

function makePrismaStub(tokenStore: ReturnType<typeof makeToken>[] = []) {
  return {
    customerEmailToken: {
      create: vi.fn(async ({ data }: any) => {
        const token = makeToken({
          id: `tok-${Date.now()}-${Math.random()}`,
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
        const now = new Date();
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
}

function makeService(tokenStore: ReturnType<typeof makeToken>[] = []) {
  const prisma = makePrismaStub(tokenStore);
  const service = new CustomerEmailTokenService(prisma as any);
  return { service, prisma, tokenStore };
}

// ── 1. issueToken ─────────────────────────────────────────────────────────────

describe("CustomerEmailTokenService.issueToken", () => {
  it("stores only the sha256 hash — not the plaintext", async () => {
    const { service, tokenStore } = makeService();
    const plaintext = await service.issueToken(
      "cust-1",
      CustomerEmailTokenPurpose.VERIFY_EMAIL,
      30 * 60 * 1000
    );

    expect(tokenStore).toHaveLength(1);
    const storedHash = tokenStore[0].tokenHash;

    // Hash stored must equal sha256(plaintext)
    expect(storedHash).toBe(sha256(plaintext));
    // Plaintext must not appear anywhere in stored token
    expect(storedHash).not.toBe(plaintext);
    expect(storedHash).not.toContain(plaintext);
  });

  it("stores correct purpose", async () => {
    const { service, tokenStore } = makeService();
    await service.issueToken(
      "cust-1",
      CustomerEmailTokenPurpose.RESET_PASSWORD,
      30 * 60 * 1000
    );
    expect(tokenStore[0].purpose).toBe(CustomerEmailTokenPurpose.RESET_PASSWORD);
  });

  it("stores expiry within the correct TTL window", async () => {
    const { service, tokenStore } = makeService();
    const before = Date.now();
    const ttlMs = 24 * 60 * 60 * 1000; // 24h
    await service.issueToken("cust-1", CustomerEmailTokenPurpose.VERIFY_EMAIL, ttlMs);
    const after = Date.now();

    const expiresAt = tokenStore[0].expiresAt.getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + ttlMs - 100);
    expect(expiresAt).toBeLessThanOrEqual(after + ttlMs + 100);
  });

  it("returns a 64-char hex string (32 random bytes)", async () => {
    const { service } = makeService();
    const plaintext = await service.issueToken(
      "cust-1",
      CustomerEmailTokenPurpose.VERIFY_EMAIL,
      30 * 60 * 1000
    );
    expect(plaintext).toMatch(/^[0-9a-f]{64}$/);
  });

  it("two tokens for same customer produce different plaintexts and hashes", async () => {
    const { service, tokenStore } = makeService();
    const t1 = await service.issueToken("cust-1", CustomerEmailTokenPurpose.VERIFY_EMAIL, 30_000);
    const t2 = await service.issueToken("cust-1", CustomerEmailTokenPurpose.VERIFY_EMAIL, 30_000);

    expect(t1).not.toBe(t2);
    expect(tokenStore[0].tokenHash).not.toBe(tokenStore[1].tokenHash);
  });
});

// ── 2. consumeToken ───────────────────────────────────────────────────────────

describe("CustomerEmailTokenService.consumeToken", () => {
  it("returns customerId and marks usedAt on valid token", async () => {
    const { service, tokenStore } = makeService();
    const plaintext = await service.issueToken(
      "cust-42",
      CustomerEmailTokenPurpose.RESET_PASSWORD,
      30 * 60 * 1000
    );

    const result = await service.consumeToken(
      plaintext,
      CustomerEmailTokenPurpose.RESET_PASSWORD
    );

    expect(result).toBe("cust-42");
    expect(tokenStore[0].usedAt).not.toBeNull();
  });

  it("second consume of same token returns null (single-use)", async () => {
    const { service } = makeService();
    const plaintext = await service.issueToken(
      "cust-1",
      CustomerEmailTokenPurpose.VERIFY_EMAIL,
      30 * 60 * 1000
    );

    const first = await service.consumeToken(
      plaintext,
      CustomerEmailTokenPurpose.VERIFY_EMAIL
    );
    const second = await service.consumeToken(
      plaintext,
      CustomerEmailTokenPurpose.VERIFY_EMAIL
    );

    expect(first).toBe("cust-1");
    expect(second).toBeNull();
  });

  it("expired token returns null", async () => {
    const tokenStore = [
      makeToken({
        customerId: "cust-1",
        tokenHash: sha256("expiredtoken1234"),
        purpose: CustomerEmailTokenPurpose.VERIFY_EMAIL,
        expiresAt: new Date(Date.now() - 1000), // already expired
        usedAt: null
      })
    ];
    const { service } = makeService(tokenStore);

    const result = await service.consumeToken(
      "expiredtoken1234",
      CustomerEmailTokenPurpose.VERIFY_EMAIL
    );

    expect(result).toBeNull();
  });

  it("wrong purpose returns null", async () => {
    const { service } = makeService();
    const plaintext = await service.issueToken(
      "cust-1",
      CustomerEmailTokenPurpose.VERIFY_EMAIL,
      30 * 60 * 1000
    );

    const result = await service.consumeToken(
      plaintext,
      CustomerEmailTokenPurpose.RESET_PASSWORD // wrong purpose
    );

    expect(result).toBeNull();
  });

  it("nonexistent token returns null", async () => {
    const { service } = makeService();
    const result = await service.consumeToken(
      "nonexistent" + "x".repeat(56),
      CustomerEmailTokenPurpose.VERIFY_EMAIL
    );
    expect(result).toBeNull();
  });
});
