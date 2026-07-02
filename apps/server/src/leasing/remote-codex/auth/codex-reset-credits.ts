// Server-side Codex "主动重置次数" (rate-limit reset credits) — ported from
// cockpit-tools' codex_quota.rs. A Codex Plus/Pro account periodically earns a
// few credits that let it proactively reset its 5h rate-limit window before the
// timer runs out. This module lets the console query how many are available and
// spend one on demand, so a hot account can be reset instead of parked.
//
// Both calls carry the account's codex access token to chatgpt.com and, like the
// usage probe, egress through the account's exit proxy (same IP as inference)
// when one is set. Failures throw with the upstream status so the console can
// surface why (e.g. banned account, no credits left).

import * as crypto from "crypto";

import { proxyAwareFetch } from "../../lease-core/egress";
import { extractChatGPTAccountId } from "./codex-usage";

const RESET_CREDITS_URL =
  process.env.BCAI_CODEX_RESET_CREDITS_URL ||
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const RESET_CREDITS_CONSUME_URL = `${RESET_CREDITS_URL}/consume`;

// Same web-client identity cockpit sends to these endpoints; the reset-credits
// API is stricter than wham/usage and rejects requests missing these headers.
const CHATGPT_WEB_REFERER = "https://chatgpt.com/";
const CHATGPT_WEB_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

export interface CodexResetCredit {
  id?: string;
  status?: string;
  resetType?: string;
  grantedAt?: number;
  expiresAt?: number;
  redeemedAt?: number;
  rawStatus?: string;
}

export interface CodexResetCreditsSnapshot {
  availableCount: number;
  credits: CodexResetCredit[];
  nextExpiresAt?: number;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function pickTimestamp(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** A credit is spendable when it is neither redeemed/used/expired nor past its expiry. */
function isAvailable(credit: CodexResetCredit, nowSec: number): boolean {
  const status = (credit.status || credit.rawStatus || "available").trim().toLowerCase();
  if (["redeemed", "used", "consumed", "expired"].includes(status)) return false;
  return credit.expiresAt == null || credit.expiresAt > nowSec;
}

function parseCredit(value: unknown): CodexResetCredit | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    id: pickString(record, ["id", "credit_id", "creditId"]),
    status: pickString(record, ["status", "state"]),
    rawStatus: pickString(record, ["status", "state"]),
    resetType: pickString(record, ["type", "reset_type", "resetType"]),
    grantedAt: pickTimestamp(record, ["granted_at", "created_at", "grantedAt"]),
    expiresAt: pickTimestamp(record, ["expires_at", "expire_at", "expiresAt"]),
    redeemedAt: pickTimestamp(record, ["redeemed_at", "used_at", "consumed_at", "redeemedAt"]),
  };
}

/**
 * Normalize the upstream reset-credits payload into an available-count + detail
 * snapshot. `credits` may sit at the top level or under `data`; `available_count`
 * is trusted when present, otherwise derived from the spendable credits.
 */
export function parseResetCreditsSnapshot(
  payload: any,
  nowSec: number = Math.floor(Date.now() / 1000),
): CodexResetCreditsSnapshot {
  const rawCredits =
    (Array.isArray(payload?.credits) && payload.credits) ||
    (Array.isArray(payload?.data?.credits) && payload.data.credits) ||
    [];
  const credits = (rawCredits as unknown[]).map(parseCredit).filter((c): c is CodexResetCredit => !!c);

  const serverCount =
    payload?.available_count ?? payload?.availableCount ?? payload?.data?.available_count ?? payload?.data?.availableCount;
  const availableCount =
    typeof serverCount === "number" && Number.isFinite(serverCount)
      ? serverCount
      : credits.filter((c) => isAvailable(c, nowSec)).length;

  const expiries = credits.filter((c) => isAvailable(c, nowSec) && c.expiresAt != null).map((c) => c.expiresAt as number);
  const nextExpiresAt = expiries.length ? Math.min(...expiries) : undefined;

  return { availableCount, credits, nextExpiresAt };
}

function buildHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    Referer: CHATGPT_WEB_REFERER,
    "User-Agent": CHATGPT_WEB_USER_AGENT,
    "OpenAI-Beta": "codex-1",
    originator: "Codex Desktop",
  };
  const accId = extractChatGPTAccountId(accessToken);
  if (accId) headers["ChatGPT-Account-Id"] = accId;
  return headers;
}

/** Query the account's spendable reset credits. Throws on any non-2xx / network error. */
export async function fetchCodexResetCredits(
  accessToken: string,
  proxyUrl?: string,
): Promise<CodexResetCreditsSnapshot> {
  if (!accessToken) throw new Error("缺少 access token");
  const resp = await proxyAwareFetch(proxyUrl, RESET_CREDITS_URL, {
    method: "GET",
    headers: buildHeaders(accessToken),
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`重置次数查询失败: ${resp.status} ${body.slice(0, 200)}`);
  return parseResetCreditsSnapshot(JSON.parse(body));
}

/** Spend one reset credit (proactively resets the 5h window). Throws on failure. */
export async function consumeCodexResetCredit(accessToken: string, proxyUrl?: string): Promise<void> {
  if (!accessToken) throw new Error("缺少 access token");
  const resp = await proxyAwareFetch(proxyUrl, RESET_CREDITS_CONSUME_URL, {
    method: "POST",
    headers: buildHeaders(accessToken),
    body: JSON.stringify({ redeem_request_id: crypto.randomUUID() }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`主动重置失败: ${resp.status} ${body.slice(0, 200)}`);
  }
}
