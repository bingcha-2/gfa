import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaseService } from "../lease-service";
import type { Provider } from "../provider";
import { sessionReqFor, withSessionResolver } from "../../token-server/__tests__/session-test-util";

const REQ = sessionReqFor("card-1");
const MODEL = "gpt-6-astra";
let directory: string;
let accountsFilePath: string;
let accessKeysFilePath: string;
let now: number;
let sequence: number;
let services: LeaseService<any>[];
const refreshToken = vi.fn(async () => "test-access-token");
const recordBan = vi.fn();

function service() {
  const provider: Provider<any> = {
    id: "codex", accountsFilePath, refreshToken,
    normalizeAccount: (account) => ({ ...account, enabled: account.enabled !== false }),
    isAccountEligible: () => true,
    applyQuotaSnapshot: (account) => ({ account, creditDelta: null }),
    egressPolicy: "optional", leaseResponseExtras: () => ({}),
    rateLimitZeroCooldown: true, // Old provider configuration must still back off.
  };
  const instance = withSessionResolver(new LeaseService(provider, {
    accessKeysFilePath, minClientVersion: "", now: () => now,
    randomId: () => `review-lease-${++sequence}`,
    banEventRecorder: { recordBan, observeRequest: vi.fn() },
  }));
  services.push(instance);
  return instance;
}

function diskAccount() { return JSON.parse(fs.readFileSync(accountsFilePath, "utf8")).accounts[0]; }
function lease(svc: LeaseService<any>) { return svc.leaseToken(REQ, { clientId: "device", modelKey: MODEL }); }

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-codex-review-"));
  accountsFilePath = path.join(directory, "accounts.json");
  accessKeysFilePath = path.join(directory, "keys.json");
  fs.writeFileSync(accountsFilePath, JSON.stringify({ accounts: [{ id: 1, email: "test@example.com", refreshToken: "rt-test", enabled: true }] }));
  fs.writeFileSync(accessKeysFilePath, JSON.stringify({ keys: [{ id: "card-1", key: "secret", status: "active", durationMs: 30 * 24 * 60 * 60_000 }] }));
  now = 1_000_000; sequence = 0; services = [];
  refreshToken.mockClear(); recordBan.mockClear();
});
afterEach(async () => {
  for (const svc of services) await svc.onModuleDestroy();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("Codex account review holds", () => {
  it.each([200, 400, 403])("holds explicit deactivation at HTTP %s without changing enabled or credentials", async (status) => {
    const svc = service();
    const issued = await lease(svc);
    await svc.reportResult(REQ, { leaseId: issued.leaseId, reportId: "deactivated", status,
      codexDiagnostic: { result: "failed", sentModel: MODEL, errorCode: "account_deactivated" } });
    expect(diskAccount()).toMatchObject({ enabled: true, refreshToken: "rt-test", quotaStatus: "error",
      quotaStatusReason: "account_deactivated", blockedUntil: 0, codexAccountReviewSource: "client_report",
      codexAccountReviewFirstObservedAt: now, codexAccountReviewLastObservedAt: now });
    expect((svc as any).isAccountBlocked(1, "another-model", now, true)).toBe(true);
    expect(recordBan).toHaveBeenCalledTimes(1);
    await expect(lease(svc)).rejects.toThrow();
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it.each(["account_deactivated", "account_verification_required"])("%s survives stale success, soft errors, refresh and restart until explicit recovery", async (errorCode) => {
    const svc = service();
    const issued = await lease(svc);
    await svc.reportResult(REQ, { leaseId: issued.leaseId, reportId: "hold", status: 200,
      codexDiagnostic: { result: "failed", sentModel: MODEL, requestSequence: 2, errorCode } });
    await svc.reportResult(REQ, { leaseId: issued.leaseId, reportId: "stale-success", status: 200 });
    await svc.reportResult(REQ, { leaseId: issued.leaseId, reportId: "later-success", status: 200,
      codexDiagnostic: { result: "completed", sentModel: MODEL, requestSequence: 3 } });
    (svc as any).markAccountExhausted(1, MODEL, "codex_rate_limit", 1000);
    expect(svc.reactivateIfAuthDead(1)).toEqual({ ok: true, reactivated: false });
    now += 2 * 24 * 60 * 60_000;
    expect((svc as any).isAccountBlocked(1, MODEL, now)).toBe(true);
    const restarted = service();
    await restarted.onModuleInit();
    await expect(lease(restarted)).rejects.toThrow();
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(restarted.reactivateAccount(1)).toEqual({ ok: true });
    expect(diskAccount().codexAccountReviewResolvedAt).toBe(now);
    now += 1;
    expect((await lease(restarted)).accountId).toBe(1);
  });

  it("does not expire a pre-existing explicit hold with an old blockedUntil", async () => {
    fs.writeFileSync(accountsFilePath, JSON.stringify({ accounts: [{ ...diskAccount(), quotaStatus: "error",
      quotaStatusReason: "verification_required", blockedUntil: now - 1 }] }));
    const svc = service();
    await svc.onModuleInit();
    await expect(lease(svc)).rejects.toThrow();
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it.each(["<html>verification required account_deactivated</html>", "http_403_permission_denied", "suspended", "needs verification"])("does not turn vague 403 reason %s into a review hold", async (reason) => {
    const svc = service(); const issued = await lease(svc);
    await svc.reportResult(REQ, { leaseId: issued.leaseId, reportId: "html", status: 403, reason, errorText: reason });
    expect((svc as any).accountRuntime.get(1).quotaStatus).not.toBe("error");
    expect(recordBan).not.toHaveBeenCalled();
    now += 61_000;
    expect((svc as any).isAccountBlocked(1, MODEL, now)).toBe(false);
  });

  it("requires a valid lease association and accepts exact legacy error codes", async () => {
    const svc = service();
    await svc.reportResult(REQ, { accountId: 1, reportId: "unleased", status: 403, reason: "account_deactivated" });
    expect(diskAccount().quotaStatus).toBeUndefined();
    const issued = await lease(svc);
    await svc.reportResult(REQ, { leaseId: issued.leaseId, reportId: "legacy", status: 403, reason: "http_403_account_deactivated" });
    expect(diskAccount().quotaStatus).toBe("error");
  });

  it("does not reapply a report from a lease predating explicit administrator recovery", async () => {
    const svc = service(); const issued = await lease(svc);
    const report = (id: string) => svc.reportResult(REQ, { leaseId: issued.leaseId, reportId: id, status: 403, reason: "http_403_account_deactivated" });
    await report("hold"); now += 100;
    svc.reactivateAccount(1);
    await report("delayed-old-hold");
    expect((svc as any).isAccountBlocked(1, MODEL, now)).toBe(false);
  });

  it.each([0, 30_000, 999_999])("allows fixed-account retries during legacy 429 cooldown with retryAfter=%s", async (retryAfterMs) => {
    const keys = JSON.parse(fs.readFileSync(accessKeysFilePath, "utf8"));
    keys.keys[0].bindings = { codex: 1 };
    fs.writeFileSync(accessKeysFilePath, JSON.stringify(keys));
    const svc = service(); const issued = await lease(svc);
    await svc.reportResult(REQ, { leaseId: issued.leaseId, reportId: "limited", status: 429,
      reason: "http_429_too_many_requests", retryAfterMs });
    const duration = Math.min(retryAfterMs || 10_000, 300_000);
    expect((svc as any).isAccountBlocked(1, MODEL, now, true)).toBe(false);
    expect((svc as any).isAccountBlocked(1, MODEL, now, false)).toBe(true);
    expect((await lease(svc)).accountId).toBe(1);
    expect((svc as any).accountRuntime.get(1).exhaustedUntil).toBe(now + duration);
    now += duration + 1;
    expect((svc as any).isAccountBlocked(1, MODEL, now, true)).toBe(false);
    expect((await lease(svc)).accountId).toBe(1);
  });
});
