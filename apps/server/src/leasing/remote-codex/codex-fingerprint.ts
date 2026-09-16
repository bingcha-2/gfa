import { createHash } from "crypto";

export const CODEX_FINGERPRINT_MODES = ["off", "device", "session", "full"] as const;
export type CodexFingerprintMode = typeof CODEX_FINGERPRINT_MODES[number];

export function codexFingerprintMode(value: unknown): CodexFingerprintMode {
  return CODEX_FINGERPRINT_MODES.includes(value as CodexFingerprintMode) ? value as CodexFingerprintMode : "off";
}

/** The seed is generated and persisted by account management, never during a lease. */
export function codexFingerprintLease(account: Record<string, unknown>) {
  const mode = codexFingerprintMode(account.codexFingerprintMode);
  const seed = account.codexFingerprintSeed;
  if (mode === "off" || typeof seed !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(seed)) return undefined;
  const derive = (label: string) => {
    const bytes = createHash("sha256").update(`gfa:codex-fingerprint:v1:${label}:${seed}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  return { mode, installationId: derive("installation"), sessionId: derive("session"), namespace: derive("namespace") };
}

/** Non-generation probes carry only device identity, never fabricated turn data. */
export function codexFingerprintProbeHeaders(account: Record<string, unknown>): Record<string, string> {
  const identity = codexFingerprintLease(account);
  return identity ? { "x-codex-installation-id": identity.installationId } : {};
}
