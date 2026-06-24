import * as path from "path";

import { AdsPowerClient, type AdsPowerProfileSummary } from "./adspower-client";
import { nowIso, readJson, toSocks5ProxyUrl, writeJson } from "./store";

export type AdspowerProfileProvider = "anthropic" | "codex" | "antigravity";

export type AdspowerProfileAccount = {
  id?: number | string;
  email?: string;
  proxyUrl?: string;
  adspowerProfileId?: string;
  adspowerProfileStatus?: string;
  adspowerProfileProvider?: string;
  adspowerProfileCreatedAt?: string;
  adspowerProfileLastUsedAt?: string;
  adspowerProfileTrashedAt?: string;
  adspowerProfileProtected?: boolean;
};

export type AdspowerLifecycleClient = Pick<
  AdsPowerClient,
  "listProfiles" | "createProfile" | "deleteProfiles" | "checkProfile"
>;

export type EnsureAdspowerProfileOptions = {
  dataDir: string;
  provider: AdspowerProfileProvider;
  account: AdspowerProfileAccount;
  client?: AdspowerLifecycleClient;
  now?: () => Date;
  profileCap?: number;
  protectMinutes?: number;
};

export type EnsureAdspowerProfileResult =
  | { ok: true; profileId: string; created: boolean; deletedProfileId?: string }
  | { ok: false; error: string; needsRestore?: boolean; profileId?: string };

type PoolFile = {
  provider: AdspowerProfileProvider;
  fileName: string;
};

const POOL_FILES: PoolFile[] = [
  { provider: "codex", fileName: "codex-accounts.json" },
  { provider: "anthropic", fileName: "anthropic-accounts.json" },
  { provider: "anthropic", fileName: "anthropic-precharge-accounts.json" },
  { provider: "antigravity", fileName: "accounts.json" },
];

const PROVIDER_DEFAULTS: Record<AdspowerProfileProvider, { domainName: string; openUrls: string[] }> = {
  anthropic: { domainName: "claude.ai", openUrls: ["https://claude.ai"] },
  codex: { domainName: "auth.openai.com", openUrls: ["https://auth.openai.com"] },
  antigravity: { domainName: "accounts.google.com", openUrls: ["https://accounts.google.com"] },
};

export function makeDefaultAdsPowerClient(): AdsPowerClient {
  return new AdsPowerClient({
    baseUrl: process.env.ADSPOWER_HOST || "http://127.0.0.1:50325",
    apiKey: process.env.ADSPOWER_API_KEY || "",
  });
}

export function parseProxyToAdsPowerUserConfig(proxyUrl: string): any {
  const proxy = String(proxyUrl || "").trim();
  if (!proxy) return null;
  try {
    const url = new URL(proxy);
    const type = url.protocol.replace(":", "").toLowerCase();
    if (!["http", "https", "socks5", "socks5h"].includes(type)) return null;
    const normalizedType = type === "socks5h" ? "socks5" : type;
    const config: any = {
      proxy_soft: "other",
      proxy_type: normalizedType,
      proxy_host: url.hostname,
      proxy_port: String(url.port || (normalizedType === "socks5" ? 1080 : 80)),
    };
    if (url.username) config.proxy_user = decodeURIComponent(url.username);
    if (url.password) config.proxy_password = decodeURIComponent(url.password);
    return config;
  } catch {
    return null;
  }
}

export async function ensureAdspowerProfileForAccount(
  opts: EnsureAdspowerProfileOptions,
): Promise<EnsureAdspowerProfileResult> {
  const now = opts.now?.() || new Date();
  const client = opts.client || makeDefaultAdsPowerClient();
  const profiles = await client.listProfiles();
  const profileIds = new Set(profiles.map(profileIdOf).filter(Boolean));
  const storedProfileId = String(opts.account.adspowerProfileId || "").trim();

  if (storedProfileId) {
    if (profileIds.has(storedProfileId)) {
      markProfileActive(opts.account, opts.provider, now);
      return { ok: true, profileId: storedProfileId, created: false };
    }
    opts.account.adspowerProfileStatus = "trashed";
    opts.account.adspowerProfileTrashedAt = now.toISOString();
    return {
      ok: false,
      needsRestore: true,
      profileId: storedProfileId,
      error: `AdsPower profile ${storedProfileId} is missing. Restore it from AdsPower Trash, then retry this same account.`,
    };
  }

  const proxyUrl = normalizeProxyForProvider(opts.provider, opts.account.proxyUrl || "");
  if (!proxyUrl) {
    return { ok: false, error: "proxyUrl is required to create a new AdsPower profile" };
  }
  const proxyConfig = parseProxyToAdsPowerUserConfig(proxyUrl);
  if (!proxyConfig) {
    return { ok: false, error: "proxyUrl cannot be converted to AdsPower proxy config" };
  }

  let deletedProfileId = "";
  const profileCap = Number(opts.profileCap ?? process.env.ADSPOWER_PROFILE_CAP ?? 10);
  if (profileCap > 0 && profiles.length >= profileCap) {
    const deleted = await deleteOldestSafeProfile({
      dataDir: opts.dataDir,
      currentProvider: opts.provider,
      currentAccount: opts.account,
      profileIds,
      client,
      now,
      protectMinutes: Number(opts.protectMinutes ?? process.env.ADSPOWER_PROFILE_PROTECT_MINUTES ?? 60),
    });
    if (!deleted.ok) return { ok: false, error: deleted.error };
    deletedProfileId = deleted.profileId;
  }

  const defaults = PROVIDER_DEFAULTS[opts.provider];
  const created = await client.createProfile({
    name: buildProfileName(opts.provider, opts.account),
    domainName: defaults.domainName,
    openUrls: defaults.openUrls,
    proxyConfig,
    fingerprintConfig: defaultFingerprintConfig(),
  });

  opts.account.proxyUrl = proxyUrl;
  opts.account.adspowerProfileId = created.profileId;
  opts.account.adspowerProfileCreatedAt = now.toISOString();
  markProfileActive(opts.account, opts.provider, now);
  return { ok: true, profileId: created.profileId, created: true, ...(deletedProfileId ? { deletedProfileId } : {}) };
}

function normalizeProxyForProvider(provider: AdspowerProfileProvider, proxyUrl: string): string {
  return provider === "anthropic" ? toSocks5ProxyUrl(proxyUrl) : String(proxyUrl || "").trim();
}

function markProfileActive(account: AdspowerProfileAccount, provider: AdspowerProfileProvider, now: Date) {
  account.adspowerProfileStatus = "active";
  account.adspowerProfileProvider = provider;
  account.adspowerProfileLastUsedAt = now.toISOString();
  delete account.adspowerProfileTrashedAt;
}

function buildProfileName(provider: AdspowerProfileProvider, account: AdspowerProfileAccount): string {
  const email = String(account.email || "account").trim() || "account";
  return `${provider}-${email}`.replace(/[^\w.@+-]+/g, "-").slice(0, 80);
}

function defaultFingerprintConfig(): Record<string, unknown> {
  return {
    automatic_timezone: "1",
    language: ["en-US", "en"],
    webrtc: "proxy",
  };
}

function profileIdOf(profile: AdsPowerProfileSummary | any): string {
  return String(profile?.userId || profile?.user_id || profile?.id || profile?.profile_id || "").trim();
}

async function deleteOldestSafeProfile(opts: {
  dataDir: string;
  currentProvider: AdspowerProfileProvider;
  currentAccount: AdspowerProfileAccount;
  profileIds: Set<string>;
  client: AdspowerLifecycleClient;
  now: Date;
  protectMinutes: number;
}): Promise<{ ok: true; profileId: string } | { ok: false; error: string }> {
  const candidates = collectSafeProfileCandidates(opts);
  for (const candidate of candidates) {
    const active = await opts.client.checkProfile(candidate.profileId).catch(() => ({ active: true }));
    if (active.active) continue;

    await opts.client.deleteProfiles([candidate.profileId]);
    const data = readJson(candidate.filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const acc = accounts.find((item: any) => sameAccount(item, candidate.account));
    if (acc) {
      acc.adspowerProfileStatus = "trashed";
      acc.adspowerProfileTrashedAt = opts.now.toISOString();
      writeJson(candidate.filePath, { ...data, accounts, updatedAt: nowIso() });
    }
    return { ok: true, profileId: candidate.profileId };
  }
  return { ok: false, error: "AdsPower profile cap is full and no safe idle profile can be deleted" };
}

function collectSafeProfileCandidates(opts: {
  dataDir: string;
  currentProvider: AdspowerProfileProvider;
  currentAccount: AdspowerProfileAccount;
  profileIds: Set<string>;
  now: Date;
  protectMinutes: number;
}) {
  const protectMs = Math.max(0, opts.protectMinutes) * 60_000;
  const out: Array<{
    provider: AdspowerProfileProvider;
    filePath: string;
    account: any;
    profileId: string;
    sortTime: number;
  }> = [];
  for (const pool of POOL_FILES) {
    const filePath = path.join(opts.dataDir, pool.fileName);
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    for (const account of accounts) {
      const profileId = String(account.adspowerProfileId || "").trim();
      if (!profileId || !opts.profileIds.has(profileId)) continue;
      if (sameAccount(account, opts.currentAccount) && pool.provider === opts.currentProvider) continue;
      if (String(account.adspowerProfileStatus || "active") === "trashed") continue;
      if (account.adspowerProfileProtected === true) continue;
      const lastTime = timestampOf(
        account.adspowerProfileLastUsedAt ||
          account.adspowerProfileCreatedAt ||
          account.updatedAt ||
          account.createdAt,
      );
      if (lastTime && opts.now.getTime() - lastTime < protectMs) continue;
      out.push({ provider: pool.provider, filePath, account, profileId, sortTime: lastTime || 0 });
    }
  }
  out.sort((a, b) => a.sortTime - b.sortTime || a.profileId.localeCompare(b.profileId));
  return out;
}

function sameAccount(a: any, b: any): boolean {
  const aid = Number(a?.id || 0);
  const bid = Number(b?.id || 0);
  if (aid && bid && aid === bid) return true;
  const ae = String(a?.email || "").toLowerCase();
  const be = String(b?.email || "").toLowerCase();
  return Boolean(ae && be && ae === be);
}

function timestampOf(value: unknown): number {
  const text = String(value || "").trim();
  if (!text) return 0;
  const n = Date.parse(text);
  return Number.isFinite(n) ? n : 0;
}
