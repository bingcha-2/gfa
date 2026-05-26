import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

import { JwtPayload } from "./auth.service";

const CONSOLE_COOKIE = "gfa.console.token";

function fromCookie(req: { cookies?: Record<string, string> }): string | null {
  return req?.cookies?.[CONSOLE_COOKIE] ?? null;
}

// Known weak/placeholder secrets — reject these unconditionally
const WEAK_SECRETS = [
  "secret",
  "jwt-secret",
  "your-secret-key",
  "gfa-dev-secret-change-in-production",
  "change-me",
  "REPLACE_WITH_A_STRONG_RANDOM_SECRET_AT_LEAST_32_CHARS",
];

function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error(
      "[FATAL] JWT_SECRET environment variable is not set. " +
        "Set a strong secret (32+ chars) in your .env file before starting the server."
    );
  }

  // S-04: Reject known weak/placeholder secrets
  if (WEAK_SECRETS.includes(secret)) {
    throw new Error(
      "[FATAL] JWT_SECRET is using a known weak/default value — this is a critical security risk. " +
        "Generate a new secret: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }

  // Warn (but allow) short secrets in dev, reject in production
  if (secret.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[FATAL] JWT_SECRET must be at least 32 characters in production. Current length: " + secret.length
      );
    }
    console.warn(
      `[SECURITY] JWT_SECRET is only ${secret.length} chars — use 32+ chars for production.`
    );
  }

  return secret;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        fromCookie,
      ]),
      ignoreExpiration: false,
      secretOrKey: requireJwtSecret()
    });
  }

  validate(payload: JwtPayload) {
    return {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      permissions: payload.permissions ?? null
    };
  }
}
