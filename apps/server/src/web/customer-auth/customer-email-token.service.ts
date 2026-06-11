import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { CustomerEmailTokenPurpose } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * CustomerEmailTokenService
 *
 * Single-responsibility service for issuing and consuming single-use
 * email tokens (VERIFY_EMAIL and RESET_PASSWORD).
 *
 * Security contract:
 *   - Only the sha256 hash is stored in the DB — the plaintext token is
 *     returned ONCE to the caller and never persisted.
 *   - consumeToken uses updateMany with conditions (usedAt null + expiry check)
 *     to atomically mark the token used, avoiding double-consume races.
 */
@Injectable()
export class CustomerEmailTokenService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Issue a new single-use email token.
   * @returns the plaintext token (not stored); caller must include it in the link.
   */
  async issueToken(
    customerId: string,
    purpose: CustomerEmailTokenPurpose,
    ttlMs: number
  ): Promise<string> {
    const plaintext = randomBytes(32).toString("hex");
    const tokenHash = sha256(plaintext);
    const expiresAt = new Date(Date.now() + ttlMs);

    await this.prisma.customerEmailToken.create({
      data: {
        customerId,
        tokenHash,
        purpose,
        expiresAt
      }
    });

    return plaintext;
  }

  /**
   * Consume a token.
   * @returns customerId on success, null if token is invalid, expired, already used, or wrong purpose.
   */
  async consumeToken(
    plaintext: string,
    purpose: CustomerEmailTokenPurpose
  ): Promise<string | null> {
    const tokenHash = sha256(plaintext);

    // Find token with matching hash, purpose, unused, and not expired
    const token = await this.prisma.customerEmailToken.findUnique({
      where: { tokenHash }
    });

    if (!token) return null;
    if (token.purpose !== purpose) return null;
    if (token.usedAt !== null) return null;
    if (token.expiresAt <= new Date()) return null;

    // Atomically mark as used — updateMany with conditions guards against races
    const result = await this.prisma.customerEmailToken.updateMany({
      where: {
        tokenHash,
        purpose,
        usedAt: null,
        expiresAt: { gt: new Date() }
      },
      data: {
        usedAt: new Date()
      }
    });

    // If no rows were updated, another request consumed it concurrently
    if (result.count === 0) return null;

    return token.customerId;
  }
}
