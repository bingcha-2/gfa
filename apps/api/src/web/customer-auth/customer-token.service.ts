import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomBytes, randomUUID } from "node:crypto";

// Known weak/placeholder secrets — rejected unconditionally (mirrors admin jwt.strategy.ts)
const WEAK_SECRETS = [
  "secret",
  "jwt-secret",
  "your-secret-key",
  "gfa-dev-secret-change-in-production",
  "change-me",
  "REPLACE_WITH_A_STRONG_RANDOM_SECRET_AT_LEAST_32_CHARS",
];

export function resolveCustomerJwtSecret(): string {
  const secret = process.env.CUSTOMER_JWT_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[FATAL] CUSTOMER_JWT_SECRET is not set. " +
          "Set a strong secret (32+ chars) in your .env file before starting the server."
      );
    }

    const base = process.env.JWT_SECRET ?? "dev";
    const derived = `${base}-customer`;
    console.warn(
      "[SECURITY] CUSTOMER_JWT_SECRET is not set — deriving from JWT_SECRET for dev. " +
        "Set CUSTOMER_JWT_SECRET explicitly in production."
    );
    return derived;
  }

  if (WEAK_SECRETS.includes(secret)) {
    throw new Error(
      "[FATAL] CUSTOMER_JWT_SECRET is using a known weak/default value — critical security risk. " +
        "Generate a new secret: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }

  if (secret.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[FATAL] CUSTOMER_JWT_SECRET must be at least 32 characters in production. Current length: " +
          secret.length
      );
    }
    console.warn(
      `[SECURITY] CUSTOMER_JWT_SECRET is only ${secret.length} chars — use 32+ chars for production.`
    );
  }

  return secret;
}

export interface CustomerJwtPayload {
  /** Customer id */
  sub: string;
  email: string;
  /** Token type — must be "user-session" for customer tokens */
  typ: "user-session";
  /** tokenVersion at sign time — used for revocation */
  tv: number;
  /** Device id (optional — set by app surface login) */
  deviceId?: string;
  /** JWT ID — random per issuance; stored on Device.sessionJti */
  jti: string;
}

@Injectable()
export class CustomerTokenService {
  constructor(private readonly jwt: JwtService) {}

  sign(payload: {
    customerId: string;
    email: string;
    tokenVersion: number;
    deviceId?: string;
  }): string {
    const claims: CustomerJwtPayload = {
      sub: payload.customerId,
      email: payload.email,
      typ: "user-session",
      tv: payload.tokenVersion,
      jti: randomUUID(),
      ...(payload.deviceId ? { deviceId: payload.deviceId } : {})
    };

    return this.jwt.sign(claims, {
      secret: resolveCustomerJwtSecret(),
      expiresIn: "30d"
    });
  }

  /**
   * Decode and verify a customer JWT.
   * Returns null if signature is invalid, expired, or typ is wrong.
   */
  verify(token: string): CustomerJwtPayload | null {
    try {
      const payload = this.jwt.verify<CustomerJwtPayload>(token, {
        secret: resolveCustomerJwtSecret()
      });

      if (payload.typ !== "user-session") {
        return null;
      }

      return payload;
    } catch {
      return null;
    }
  }
}
