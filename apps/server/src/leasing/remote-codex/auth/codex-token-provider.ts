import { codexUpstreamFetch, assertCodexFingerprintProxy, codexFingerprintProbeHeaders } from "../codex-fingerprint";
import * as path from "path";
import { redactLogText } from "../../token-server/log-redaction";
import { assertCodexAccountMaintenanceAllowed, CodexLocalCredentialError, codexCredentialStamp, readCodexStoredAccount, updateCodexStoredAccount } from "./codex-account-store";

const CODEX_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export type CodexAccount = {
  id: number;
  email: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  enabled?: boolean;
  planType?: string;
  // Optional sticky per-account exit proxy (residential IP). When set, the token
  // refresh is routed through it so refresh and inference share one egress IP.
  proxyUrl?: string;
  [key: string]: unknown;
};

type RefreshOptions = {
  /** Production callers must pass their actual pool path (including custom data dirs). */
  accountsFilePath?: string;
  /** Refresh only if this exact token was rejected; concurrent 401s share one rotation. */
  rejectedAccessToken?: string;
};

type RefreshResult = Pick<CodexAccount, "accessToken" | "accessTokenExpiresAt" | "refreshToken">;
type RefreshJob = { pending?: Promise<RefreshResult>; result?: RefreshResult };
const refreshJobs = new Map<string, RefreshJob>();
const MAX_REFRESH_JOBS = 10_000;

function copyCredentials(target: CodexAccount, source: CodexAccount | RefreshResult): void {
  target.accessToken = source.accessToken;
  target.accessTokenExpiresAt = source.accessTokenExpiresAt;
  target.refreshToken = source.refreshToken;
  if ("codexCredentialVersion" in source) target.codexCredentialVersion = source.codexCredentialVersion;
}

function accountContext(account: CodexAccount): string {
  return JSON.stringify([
    account.codexCredentialVersion || "", account.enabled !== false, account.proxyUrl || "",
    account.codexFingerprintMode || "off", account.codexFingerprintSeed || "",
  ]);
}

export async function refreshCodexAccessToken(account: CodexAccount, options: RefreshOptions = {}): Promise<string> {
  const callerStamp = codexCredentialStamp(account);
  let source = { ...account };
  if (options.accountsFilePath) {
    const stored = readCodexStoredAccount(options.accountsFilePath, account.id).account;
    if (String(stored.email || "").toLowerCase() !== String(account.email || "").toLowerCase()) {
      throw new CodexLocalCredentialError("Codex account identity changed; retry with the current account");
    }
    if (accountContext(stored) !== accountContext(account)) {
      throw new CodexLocalCredentialError("Codex account configuration changed; retry with the current account");
    }
    source = { ...stored };
  }
  assertCodexAccountMaintenanceAllowed(source);
  assertCodexFingerprintProxy(source);
  const force = options.rejectedAccessToken !== undefined && source.accessToken === options.rejectedAccessToken;
  if (!force && source.accessToken && Number(source.accessTokenExpiresAt || 0) > Date.now() + REFRESH_BUFFER_MS) {
    copyCredentials(account, source);
    return source.accessToken;
  }
  const resolvedPath = options.accountsFilePath ? path.resolve(options.accountsFilePath) : "unpersisted";
  const scope = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
  const key = `${scope}:${codexCredentialStamp(source)}`;
  let job = refreshJobs.get(key);
  if (!job) {
    if (refreshJobs.size >= MAX_REFRESH_JOBS) throw new CodexLocalCredentialError("Too many pending Codex credential refreshes");
    job = {};
    refreshJobs.set(key, job);
  }
  const entry = job;
  if (!entry.pending) {
    entry.pending = (async () => {
      // Keep a rotated token after a failed write so a retry persists it instead
      // of reusing the now-consumed refresh token against the upstream.
      if (!entry.result) entry.result = await requestCodexAccessToken(source);
      if (options.accountsFilePath) {
        try {
          updateCodexStoredAccount(options.accountsFilePath, source, (stored) => Object.assign(stored, entry.result), { allowRestricted: true });
        } catch (error) {
          // A changed/removed identity makes this result obsolete, but I/O
          // failures keep it recoverable in this process until a later retry.
          try {
            const current = readCodexStoredAccount(options.accountsFilePath, account.id).account;
            if (codexCredentialStamp(current) !== codexCredentialStamp(source)) refreshJobs.delete(key);
          } catch { /* Retain on an unreadable store as well. */ }
          throw error;
        }
      }
      refreshJobs.delete(key);
      return entry.result;
    })().catch((error) => {
      if (!entry.result) refreshJobs.delete(key);
      throw error;
    }).finally(() => { entry.pending = undefined; });
  }
  const result = await entry.pending;
  // A caller may itself have been re-authorized while awaiting the shared job.
  if (codexCredentialStamp(account) !== callerStamp
    && codexCredentialStamp(account) !== codexCredentialStamp({ ...source, ...result })) {
    throw new CodexLocalCredentialError("Codex credentials changed during refresh");
  }
  if (options.accountsFilePath) {
    const current = readCodexStoredAccount(options.accountsFilePath, account.id).account;
    assertCodexAccountMaintenanceAllowed(current);
    if (codexCredentialStamp(current) !== codexCredentialStamp({ ...source, ...result })) {
      throw new CodexLocalCredentialError("Codex credentials changed during refresh");
    }
    if (accountContext(current) !== accountContext(source)) {
      throw new CodexLocalCredentialError("Codex account configuration changed during refresh");
    }
  }
  copyCredentials(account, { ...source, ...result });
  return result.accessToken!;
}

async function requestCodexAccessToken(account: CodexAccount): Promise<RefreshResult> {
  assertCodexFingerprintProxy(account);
  if (!account.refreshToken) {
    throw new Error(`Codex token refresh failed for ${account.email}: missing refresh_token`);
  }

  const body = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
    scope: "openid profile email",
  });

  // Route through the account's exit proxy when one is set (same egress IP as
  // inference). A bad/unsupported proxy URL throws rather than silently going
  // direct from the datacenter IP.
  let response: Response;
  try {
    response = await codexUpstreamFetch(account.proxyUrl, CODEX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...codexFingerprintProbeHeaders(account) },
      body,
      signal: AbortSignal.timeout(30_000),
    }, account);
  } catch (err) {
    throw new Error(`Codex token refresh failed for ${account.email}: ${redactLogText((err as Error).message)}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Codex token refresh failed for ${account.email}: ${response.status} ${redactLogText(text)}`);
  }

  let tokenData: any;
  try { tokenData = JSON.parse(text); }
  catch { throw new Error("Codex token refresh returned invalid JSON"); }
  const accessToken = String(tokenData.access_token || "");
  if (!accessToken) throw new Error(`Codex token refresh failed for ${account.email}: missing access_token`);
  const expiresIn = Number(tokenData.expires_in ?? 3600);
  return {
    accessToken,
    // Preserve a rotated refresh token even if the upstream expiry is invalid.
    // Such an access token is not considered reusable by the cache.
    accessTokenExpiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 0),
    refreshToken: tokenData.refresh_token ? String(tokenData.refresh_token) : account.refreshToken,
  };
}
