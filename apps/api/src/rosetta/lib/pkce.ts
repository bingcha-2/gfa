// OAuth PKCE + JWT helpers shared by the codex / google / claude login flows.
// Extracted verbatim from rosetta.service.ts (behavior-preserving).

import * as crypto from "crypto";

export function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

export function codeChallenge(codeVerifier: string): string {
  return base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
}

export function decodeJwtPayload(token: string): any {
  try {
    const payload = token.split(".")[1];
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}
