import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaseService } from "../lease-service";
import type { Provider } from "../provider";
import { CodexLocalCredentialError } from "../../remote-codex/auth/codex-account-store";
import { sessionReqFor, withSessionResolver } from "../../token-server/__tests__/session-test-util";

const REQ = sessionReqFor("card-1");
const MODEL = "gpt-6-astra";
let directory: string;
let accountsFilePath: string;
let accessKeysFilePath: string;
let services: LeaseService<any>[];
let sequence: number;
const initial = () => ({ id: 1, email: "test@example.com", enabled: true, codexCredentialVersion: "login-1", refreshToken: "rt-1", accessToken: "at-1", accessTokenExpiresAt: Date.now() + 3_600_000 });
const writeAccounts = (accounts: any[]) => fs.writeFileSync(accountsFilePath, JSON.stringify({ accounts }));
const readAccounts = () => JSON.parse(fs.readFileSync(accountsFilePath, "utf8")).accounts;

function makeService(refreshToken = vi.fn(async (account: any) => account.accessToken)) {
  const provider: Provider<any> = {
    id: "codex", accountsFilePath, refreshToken, persistsRefreshedCredentials: true,
    normalizeAccount: (raw) => ({ ...raw }), isAccountEligible: () => true,
    applyQuotaSnapshot: (account) => ({ account }), egressPolicy: "optional", leaseResponseExtras: () => ({}),
  };
  const service = withSessionResolver(new LeaseService(provider, {
    accessKeysFilePath, minClientVersion: "", randomId: () => `credential-lease-${++sequence}`, leaseProofSecret: "test-proof-secret",
  }));
  services.push(service);
  return service;
}
const lease = (service: LeaseService<any>) => service.leaseToken(REQ, { clientId: "device", modelKey: MODEL });

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-codex-persistence-"));
  accountsFilePath = path.join(directory, "accounts.json");
  accessKeysFilePath = path.join(directory, "keys.json");
  writeAccounts([initial()]);
  fs.writeFileSync(accessKeysFilePath, JSON.stringify({ keys: [{ id: "card-1", key: "secret", status: "active", durationMs: 3_600_000 }] }));
  services = []; sequence = 0;
});
afterEach(async () => {
  for (const service of services) await service.onModuleDestroy();
  if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unexpected test directory");
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("Codex lease credential persistence", () => {
  it("does not add a disk write for a healthy cached-token lease", async () => {
    const service = makeService();
    const before = fs.statSync(accountsFilePath).mtimeMs;
    await lease(service);
    service.flushAccounts();
    expect(fs.statSync(accountsFilePath).mtimeMs).toBe(before);
    expect((service as any)._accountsDirty).toBe(false);
  });

  it("keeps pending quota changes while refreshed credentials and fresh configuration remain authoritative", async () => {
    const refresh = vi.fn(async (account: any) => {
      const current = readAccounts()[0];
      const updated = { ...current, accessToken: "at-2", refreshToken: "rt-2", proxyUrl: "http://new-route.test:8080" };
      writeAccounts([updated]);
      Object.assign(account, { accessToken: updated.accessToken, refreshToken: updated.refreshToken });
      return updated.accessToken;
    });
    const service = makeService(refresh);
    service.mutateAccount(1, (a) => ({ ...a, codexHourlyPercent: 37 }));
    const issued = await lease(service);
    expect(issued).toMatchObject({ accessToken: "at-2", accountProxyUrl: "http://new-route.test:8080" });
    service.flushAccounts();
    expect(readAccounts()[0]).toMatchObject({ accessToken: "at-2", refreshToken: "rt-2", codexHourlyPercent: 37, proxyUrl: "http://new-route.test:8080" });
  });

  it("does not issue or overwrite a stale authorization completed after re-login", async () => {
    const service = makeService(vi.fn(async (account: any) => {
      writeAccounts([{ ...initial(), codexCredentialVersion: "login-2", accessToken: "new-login", refreshToken: "new-rt" }]);
      account.accessToken = "stale-result";
      return account.accessToken;
    }));
    await expect(lease(service)).rejects.toThrow("account changed");
    service.flushAccounts();
    expect(readAccounts()[0]).toMatchObject({ accessToken: "new-login", refreshToken: "new-rt", codexCredentialVersion: "login-2" });
    expect((service as any).accountRuntime.get(1)?.tokenDeathStrikes || 0).toBe(0);
  });

  it("does not score local persistence failures as upstream authentication failures or scan more accounts", async () => {
    writeAccounts([initial(), { ...initial(), id: 2, email: "second@example.com" }]);
    const refresh = vi.fn(async () => { throw new CodexLocalCredentialError("storage write failed"); });
    const service = makeService(refresh);
    await expect(lease(service)).rejects.toThrow("storage write failed");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((service as any).accountRuntime.get(1)?.tokenDeathStrikes || 0).toBe(0);
  });

  it("does not restore deleted accounts or apply old quota fields across re-authorization", () => {
    const service = makeService();
    service.mutateAccount(1, (a) => ({ ...a, codexHourlyPercent: 10 }));
    writeAccounts([{ ...initial(), codexCredentialVersion: "login-2", codexHourlyPercent: 80 }]);
    service.flushAccounts();
    expect(readAccounts()[0].codexHourlyPercent).toBe(80);
    service.mutateAccount(1, (a) => ({ ...a, codexHourlyPercent: 11 }));
    writeAccounts([]);
    service.flushAccounts();
    expect(readAccounts()).toEqual([]);
  });

  it("clears only the credential that actually received a 401, including signed proofs after restart", async () => {
    const service = makeService();
    const issued = await lease(service);
    writeAccounts([{ ...readAccounts()[0], accessToken: "at-new", refreshToken: "rt-new" }]);
    const restarted = makeService();
    await restarted.reportResult(REQ, { leaseId: issued.leaseId, leaseProof: issued.leaseProof, reportId: "old-401", status: 401,
      codexDiagnostic: { result: "failed", sentModel: MODEL, errorCode: "unauthorized" } });
    expect(readAccounts()[0].accessToken).toBe("at-new");
    const current = await lease(restarted);
    await restarted.reportResult(REQ, { leaseId: current.leaseId, reportId: "current-401", status: 401,
      codexDiagnostic: { result: "failed", sentModel: MODEL, errorCode: "unauthorized" } });
    expect(readAccounts()[0]).toMatchObject({ accessToken: "", accessTokenExpiresAt: 0, refreshToken: "rt-new" });
  });

  it("does not clear credentials or persist account holds from external reports without a lease", () => {
    const service = makeService();
    expect(service.applyExternalAccountFailure({ accountId: 1, status: 401, reason: "unauthorized" })).toEqual({ ok: true, action: "credential_review_required" });
    expect(service.applyExternalAccountFailure({ accountId: 1, status: 403, reason: "account_deactivated" })).toEqual({ ok: true, action: "account_review_required" });
    expect(readAccounts()[0].accessToken).toBe("at-1");
    expect(readAccounts()[0].quotaStatus).toBeUndefined();
  });
});

it("preserves Windows BOM account-store compatibility during guarded flushing", async () => {
  fs.writeFileSync(accountsFilePath, "\uFEFF" + JSON.stringify({ accounts: [initial()] }));
  const service = makeService();
  service.mutateAccount(1, (a) => ({ ...a, codexHourlyPercent: 23 }));
  service.flushAccounts();
  expect(readAccounts()[0]).toMatchObject({ accessToken: "at-1", codexHourlyPercent: 23 });
  expect((await lease(service)).accessToken).toBe("at-1");
});
it("does not overwrite an invalid null store with cached accounts", () => {
  const service = makeService();
  service.mutateAccount(1, (a) => ({ ...a, codexHourlyPercent: 23 }));
  fs.writeFileSync(accountsFilePath, "null");
  expect(() => service.flushAccounts()).toThrow(CodexLocalCredentialError);
  expect(fs.readFileSync(accountsFilePath, "utf8")).toBe("null");
  // Repair the fixture for the normal shutdown flush.
  writeAccounts([initial()]);
});