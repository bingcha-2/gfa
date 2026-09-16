import { createHash } from "crypto";
import { proxyAwareFetch, proxyRequiredFetch } from "../lease-core/egress";

// Versioned profile shared by leases and server-side Codex probes. Keep this
// profile stable across desktop upgrades; it matches our existing Codex adapter.
export const CODEX_FINGERPRINT_CLIENT_V1 = Object.freeze({
  userAgent: "codex-tui/0.154.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.154.0)",
  originator: "codex-tui",
  version: "0.154.0",
});

export const CODEX_FINGERPRINT_MODES = ["off", "device", "session", "full"] as const;
export type CodexFingerprintMode = typeof CODEX_FINGERPRINT_MODES[number];

export function codexFingerprintMode(value: unknown): CodexFingerprintMode {
  return CODEX_FINGERPRINT_MODES.includes(value as CodexFingerprintMode) ? value as CodexFingerprintMode : "off";
}

export function codexFingerprintRequiresEgress(account?: Record<string, unknown>): boolean {
  return codexFingerprintMode(account?.codexFingerprintMode) !== "off";
}

export function assertCodexFingerprintProxy(account: Record<string, unknown>): void {
  if (!codexFingerprintRequiresEgress(account)) return;
  try {
    const url = new URL(String(account.proxyUrl || "").trim());
    if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)
      || !url.hostname || (url.pathname && url.pathname !== "/") || url.search || url.hash
      || (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))) throw new Error();
  } catch {
    throw new Error("开启 Codex 指纹收敛需要绑定有效的固定出口代理（HTTP/HTTPS/SOCKS5）；不会回退直连");
  }
}

export async function codexUpstreamFetch(proxyUrl: string | undefined, url: string, init: RequestInit, account?: Record<string, unknown>) {
  if (codexFingerprintRequiresEgress(account)) {
    assertCodexFingerprintProxy({ ...account, proxyUrl });
    return proxyRequiredFetch(proxyUrl, url, init);
  }
  return proxyAwareFetch(proxyUrl, url, init);
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
  return { mode, installationId: derive("installation"), sessionId: derive("session"), namespace: derive("namespace"), client: CODEX_FINGERPRINT_CLIENT_V1 };
}

/** Non-generation probes carry only device identity, never fabricated turn data. */
export function codexFingerprintProbeHeaders(account: Record<string, unknown>): Record<string, string> {
  const identity = codexFingerprintLease(account);
  return identity ? {
    "x-codex-installation-id": identity.installationId,
    "User-Agent": identity.client.userAgent,
    Originator: identity.client.originator,
    Version: identity.client.version,
  } : {};
}
