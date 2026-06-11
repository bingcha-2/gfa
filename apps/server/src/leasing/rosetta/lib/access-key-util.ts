// Access-key (卡密) value helpers: share weight, expiry, recent token usage, key
// generation, masking. Extracted verbatim from rosetta.service.ts.

import {
  billableTokenUsageTotal,
  readTokenCount,
  DEFAULT_KEY_WINDOW_MS,
  ACCOUNT_SHARE_CAPACITY,
} from "../../token-server/token-billing";
import * as crypto from "crypto";

/** A card's share weight (份额): 1..4, default 1 (拼车). */
export function cardWeight(key: any): number {
  const w = Math.floor(Number(key?.weight || 0));
  if (!Number.isFinite(w) || w < 1) return 1;
  return Math.min(ACCOUNT_SHARE_CAPACITY, w);
}

export function maskKey(value: unknown): string {
  const raw = String(value || "");
  if (raw.length <= 4) return raw ? "***" : "";
  return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
}

export function accessKeyExpiresAt(key: any): string {
  if (!key?.firstUsedAt || !Number(key.durationMs || 0)) return "";
  return new Date(Date.parse(key.firstUsedAt) + Number(key.durationMs)).toISOString();
}

export function recentTokenUsage(key: any, now = Date.now()): number {
  const windowMs = Number(key.tokenWindowMs || key.windowMs || DEFAULT_KEY_WINDOW_MS);
  const cutoff = now - windowMs;
  return (Array.isArray(key.tokenUsageEvents) ? key.tokenUsageEvents : [])
    .filter((item: any) => Number(item?.at || 0) >= cutoff)
    .reduce((sum: number, item: any) => {
      const rawTotal =
        readTokenCount(item?.rawTotalTokens) ||
        readTokenCount(item?.totalTokens) ||
        readTokenCount(item?.inputTokens) + readTokenCount(item?.outputTokens);
      return sum + billableTokenUsageTotal({ ...item, rawTotalTokens: rawTotal }, item?.modelKey);
    }, 0);
}

export function newAccessKeyValue(): string {
  return `BCAI-${crypto.randomBytes(6).toString("hex").toUpperCase()}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}
