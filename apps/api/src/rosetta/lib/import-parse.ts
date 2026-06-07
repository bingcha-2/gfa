// Field extraction + codex-account import parsing helpers.
// Extracted verbatim from rosetta.service.ts (behavior-preserving).

export function getStringAt(source: any, pathParts: string[]): string {
  let current = source;
  for (const part of pathParts) {
    if (!current || typeof current !== "object") return "";
    current = current[part];
  }
  return typeof current === "string" ? current.trim() : "";
}

export function firstString(source: any, paths: string[][]): string {
  for (const pathParts of paths) {
    const value = getStringAt(source, pathParts);
    if (value) return value;
  }
  return "";
}

export function getNumberAt(source: any, pathParts: string[]): number {
  let current = source;
  for (const part of pathParts) {
    if (!current || typeof current !== "object") return 0;
    current = current[part];
  }
  if (typeof current === "number" && Number.isFinite(current)) return current;
  if (typeof current === "string" && current.trim() !== "" && Number.isFinite(Number(current))) {
    return Number(current);
  }
  return 0;
}

export function firstNumber(source: any, paths: string[][]): number {
  for (const pathParts of paths) {
    const value = getNumberAt(source, pathParts);
    if (value > 0) return value;
  }
  return 0;
}

export function expandCodexCandidate(account: any): any {
  if (account?.credentials && typeof account.credentials === "object") {
    return { ...account, ...account.credentials };
  }
  return account || {};
}

export function firstCodexImportCandidate(parsed: any): any {
  return collectCodexImportCandidates(parsed)[0] || {};
}

/**
 * Collect every importable account object from a pasted JSON blob.
 * Handles a bare array, our export shape `{ accounts: [...] }`, a single
 * `{ credentials: {...} }` envelope, or a single flat object. Mirrors
 * firstCodexImportCandidate but returns all candidates so an exported pool
 * can be re-imported in one paste.
 */
export function collectCodexImportCandidates(parsed: any): any[] {
  if (Array.isArray(parsed)) return parsed.filter(Boolean).map(expandCodexCandidate);
  if (Array.isArray(parsed?.accounts) && parsed.accounts.length > 0) {
    return parsed.accounts.filter(Boolean).map(expandCodexCandidate);
  }
  if (parsed?.credentials && typeof parsed.credentials === "object") {
    return [{ ...parsed, ...parsed.credentials }];
  }
  return parsed ? [parsed] : [];
}

// Stored fields beyond the core identity/token set that we preserve on a
// round-trip (export → import). Anything outside this allowlist (e.g. junk in a
// pasted blob like WARNING_BANNER) is intentionally dropped on import.
export const CODEX_PRESERVED_IMPORT_KEYS = [
  "codexHourlyPercent",
  "codexWeeklyPercent",
  "codexHourlyResetTime",
  "codexWeeklyResetTime",
  "modelQuotaFractions",
  "modelQuotaResetTimes",
  "modelQuotaRefreshedAt",
] as const;

export type CodexImportFields = {
  email: string;
  alias: string;
  planType: string;
  refreshToken: string;
  accessToken: string;
  sessionToken: string;
  accessTokenExpiresAt: number;
  enabled: boolean;
  // Allowlisted extra fields carried through verbatim (quota / reset times).
  extra: Record<string, unknown>;
};

/** Normalize one candidate object into the fields we persist to codex-accounts.json. */
export function extractCodexImportFields(source: any): CodexImportFields {
  const email = firstString(source, [["user", "email"], ["profile", "email"], ["email"], ["name"]]);
  const alias = firstString(source, [["user", "name"], ["alias"], ["name"]]);
  const planType = firstString(source, [["account", "planType"], ["planType"], ["plan_type"]]);
  const refreshToken = firstString(source, [["refreshToken"], ["refresh_token"]]);
  const accessToken = firstString(source, [["accessToken"], ["access_token"]]);
  const sessionToken = firstString(source, [["sessionToken"], ["session_token"]]);
  const expires = firstString(source, [["expires"], ["expiresAt"], ["accessTokenExpiresAt"], ["expires_at"], ["expired"]]);
  let accessTokenExpiresAt = expires ? Date.parse(expires) : 0;
  // Some token JSONs express expiry as a numeric epoch instead of a date string;
  // firstString() drops non-strings, so fall back to a numeric read and normalize
  // seconds → milliseconds (heuristic: values below ~1e12 are second-granularity).
  if (!Number.isFinite(accessTokenExpiresAt) || accessTokenExpiresAt <= 0) {
    const numericExpires = firstNumber(source, [["expires"], ["expiresAt"], ["accessTokenExpiresAt"], ["expires_at"], ["exp"]]);
    if (numericExpires > 0) {
      accessTokenExpiresAt = numericExpires < 1e12 ? Math.round(numericExpires * 1000) : numericExpires;
    }
  }
  // Carry through allowlisted extra fields (quota / reset times) so an export
  // round-trips losslessly; unknown junk is left behind.
  const extra: Record<string, unknown> = {};
  if (source && typeof source === "object") {
    for (const key of CODEX_PRESERVED_IMPORT_KEYS) {
      if (source[key] !== undefined) extra[key] = source[key];
    }
  }
  // Honor an explicit enabled flag (export round-trip); default to enabled otherwise.
  return { email, alias, planType, refreshToken, accessToken, sessionToken, accessTokenExpiresAt, enabled: source?.enabled !== false, extra };
}

export function parseJsonFromText(text: string): any | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue with embedded-object extraction below.
  }

  const start = trimmed.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth++;
    if (char === "}") depth--;
    if (depth === 0) {
      try {
        return JSON.parse(trimmed.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}
