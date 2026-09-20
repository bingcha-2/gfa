import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshCodexAccessToken } from "../auth/codex-token-provider";
import { withCodexAccessToken } from "../auth/codex-authenticated-request";
import { CodexUpstreamHttpError } from "../auth/codex-upstream-error";
import { CodexLocalCredentialError } from "../auth/codex-account-store";
import { codexUpstreamFetch } from "../codex-fingerprint";
import { CodexProvider } from "../codex.provider";
import { CodexService } from "../../rosetta/codex.service";
import * as store from "../../rosetta/lib/store";

vi.mock("../codex-fingerprint", async (original) => ({
  ...await original<any>(), codexUpstreamFetch: vi.fn(),
}));

describe("Codex credential refresh coordinator", () => {
  let dir: string;
  let file: string;
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const account = () => ({ ...read().accounts[0] });
  const write = (data: any) => fs.writeFileSync(file, JSON.stringify(data));
  const response = () => new Response(JSON.stringify({ access_token: "rotated-at", refresh_token: "rotated-rt", expires_in: 3600 }));
  beforeEach(() => {
    vi.clearAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-coordinator-"));
    file = path.join(dir, "codex-accounts.json");
    write({ accounts: [{ id: 1, email: "test@example.test", refreshToken: "old-rt", codexCredentialVersion: "generation-a", enabled: true }] });
    vi.mocked(codexUpstreamFetch).mockResolvedValue(response());
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  it("classifies a null account store as a local error without sending OAuth requests", async () => {
    const copy = account();
    write(null);
    await expect(refreshCodexAccessToken(copy, { accountsFilePath: file })).rejects.toBeInstanceOf(CodexLocalCredentialError);
    expect(codexUpstreamFetch).not.toHaveBeenCalled();
  });
  it("deduplicates lease and management copies and persists before the quota request fails", async () => {
    let finish!: (value: Response) => void;
    vi.mocked(codexUpstreamFetch).mockImplementation((_proxy, url) => {
      if (String(url).includes("/oauth/token")) return new Promise((resolve) => { finish = resolve; });
      expect(account().refreshToken).toBe("rotated-rt");
      return Promise.resolve(new Response("unavailable", { status: 503 }));
    });
    const provider = new CodexProvider({ accountsFilePath: file });
    const service = new CodexService({ dataDir: dir } as any, {} as any);
    const staleCopy = account();
    const lease = provider.refreshToken(staleCopy);
    const quota = service.refreshCodexAccountQuota({ accountId: 1 });
    expect(codexUpstreamFetch).toHaveBeenCalledTimes(1);
    finish(response());
    expect(await lease).toBe("rotated-at");
    expect(await quota).toMatchObject({ ok: true, tokenValid: true });
    expect(codexUpstreamFetch).toHaveBeenCalledTimes(2);
    expect(staleCopy.refreshToken).toBe("rotated-rt");
    expect(await provider.refreshToken({ ...staleCopy, refreshToken: "old-rt", accessToken: undefined })).toBe("rotated-at");
    expect(codexUpstreamFetch).toHaveBeenCalledTimes(2);
  });

  it("reuses a valid token for quota queries without an OAuth refresh", async () => {
    write({ accounts: [{ ...account(), accessToken: "valid", accessTokenExpiresAt: Date.now() + 3600_000 }] });
    vi.mocked(codexUpstreamFetch).mockResolvedValue(new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 20 } } })));
    const service = new CodexService({ dataDir: dir } as any, {} as any);
    expect(await service.refreshCodexAccountQuota({ accountId: 1 })).toMatchObject({ ok: true, hourlyPercent: 80 });
    expect(codexUpstreamFetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(codexUpstreamFetch).mock.calls[0][1])).toContain("/wham/usage");
  });

  it("coalesces concurrent confirmed 401s and retries each read only once", async () => {
    write({ accounts: [{ ...account(), accessToken: "rejected", accessTokenExpiresAt: Date.now() + 3600_000 }] });
    let finish!: (value: Response) => void;
    vi.mocked(codexUpstreamFetch).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const request = vi.fn(async (token: string) => {
      if (token === "rejected") throw new CodexUpstreamHttpError(401, "unauthorized");
      return token;
    });
    const reads = [withCodexAccessToken(account(), file, request), withCodexAccessToken(account(), file, request)];
    await vi.waitFor(() => expect(codexUpstreamFetch).toHaveBeenCalledTimes(1));
    finish(response());
    expect(await Promise.all(reads)).toEqual(["rotated-at", "rotated-at"]);
    expect(request).toHaveBeenCalledTimes(4);
    expect(codexUpstreamFetch).toHaveBeenCalledTimes(1);
    const alwaysRejected = vi.fn(async () => { throw new CodexUpstreamHttpError(401, "unauthorized"); });
    vi.mocked(codexUpstreamFetch).mockResolvedValue(response());
    await expect(withCodexAccessToken(account(), file, alwaysRejected)).rejects.toThrow("unauthorized");
    expect(alwaysRejected).toHaveBeenCalledTimes(2);
  });

  it("does not refresh or replay 403, 429, or a network message containing 401", async () => {
    write({ accounts: [{ ...account(), accessToken: "valid", accessTokenExpiresAt: Date.now() + 3600_000 }] });
    for (const error of [new CodexUpstreamHttpError(403, "forbidden"), new CodexUpstreamHttpError(429, "slow down"), new Error("socket at port 401")]) {
      const request = vi.fn(async () => { throw error; });
      await expect(withCodexAccessToken(account(), file, request)).rejects.toBe(error);
      expect(request).toHaveBeenCalledTimes(1);
    }
    expect(codexUpstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects an obsolete refresh after reauthorization without overwriting new credentials", async () => {
    let finish!: (value: Response) => void;
    vi.mocked(codexUpstreamFetch).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const original = account();
    const pending = refreshCodexAccessToken(original, { accountsFilePath: file });
    const newer = { ...account(), refreshToken: "reauthorized", accessToken: "new-login", codexCredentialVersion: "generation-b" };
    write({ accounts: [newer] });
    finish(response());
    await expect(pending).rejects.toBeInstanceOf(CodexLocalCredentialError);
    expect(account()).toEqual(newer);
    expect(original.refreshToken).toBe("old-rt");
  });

  it("merges only credentials while preserving concurrent edits and new accounts", async () => {
    let finish!: (value: Response) => void;
    vi.mocked(codexUpstreamFetch).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = refreshCodexAccessToken(account(), { accountsFilePath: file });
    write({ accounts: [{ ...account(), alias: "new alias" }, { id: 2, email: "other@example.test" }] });
    finish(response());
    await pending;
    expect(read().accounts).toHaveLength(2);
    expect(account()).toMatchObject({ alias: "new alias", refreshToken: "rotated-rt" });
  });

  it("retains a rotation after disk failure and retries persistence without a second OAuth request", async () => {
    const save = vi.spyOn(store, "writeJson").mockImplementationOnce(() => { throw new Error("disk full"); });
    await expect(refreshCodexAccessToken(account(), { accountsFilePath: file })).rejects.toBeInstanceOf(CodexLocalCredentialError);
    expect(account().refreshToken).toBe("old-rt");
    save.mockRestore();
    expect(await refreshCodexAccessToken(account(), { accountsFilePath: file })).toBe("rotated-at");
    expect(codexUpstreamFetch).toHaveBeenCalledTimes(1);
    expect(account().refreshToken).toBe("rotated-rt");
  });

  it("releases a failed network job for a later retry", async () => {
    vi.mocked(codexUpstreamFetch).mockRejectedValueOnce(new Error("network unavailable"));
    await expect(refreshCodexAccessToken(account(), { accountsFilePath: file })).rejects.toThrow("network unavailable");
    expect(await refreshCodexAccessToken(account(), { accountsFilePath: file })).toBe("rotated-at");
    expect(codexUpstreamFetch).toHaveBeenCalledTimes(2);
  });

  it("reads a Windows BOM-prefixed account store", async () => {
    const original = account();
    fs.writeFileSync(file, "\uFEFF" + JSON.stringify(read()));
    expect(await refreshCodexAccessToken(original, { accountsFilePath: file })).toBe("rotated-at");
    expect(account().refreshToken).toBe("rotated-rt");
  });
  it("stops maintenance on accounts awaiting review without an upstream request", async () => {
    write({ accounts: [{ ...account(), quotaStatus: "error", quotaStatusReason: "account_deactivated" }] });
    const service = new CodexService({ dataDir: dir } as any, {} as any);
    await expect(refreshCodexAccessToken(account(), { accountsFilePath: file })).rejects.toBeInstanceOf(CodexLocalCredentialError);
    expect(await service.refreshCodexAccountQuota({ accountId: 1 })).toMatchObject({ ok: false });
    expect(await service.queryCodexAccountBenefits({ accountId: 1 })).toMatchObject({ ok: false });
    expect(await service.queryCodexResetCredits({ accountId: 1 })).toMatchObject({ ok: false });
    expect(codexUpstreamFetch).not.toHaveBeenCalled();
  });

  it("saves a completed rotation but does not return a lease token after the account is held", async () => {
    let finish!: (value: Response) => void;
    vi.mocked(codexUpstreamFetch).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = refreshCodexAccessToken(account(), { accountsFilePath: file });
    write({ accounts: [{ ...account(), quotaStatus: "error", quotaStatusReason: "account_deactivated" }] });
    finish(response());
    await expect(pending).rejects.toBeInstanceOf(CodexLocalCredentialError);
    expect(account()).toMatchObject({ refreshToken: "rotated-rt", quotaStatusReason: "account_deactivated" });
  });

  it("does not restore deleted accounts when a refresh completes", async () => {
    let finish!: (value: Response) => void;
    vi.mocked(codexUpstreamFetch).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = refreshCodexAccessToken(account(), { accountsFilePath: file });
    write({ accounts: [] });
    finish(response());
    await expect(pending).rejects.toBeInstanceOf(CodexLocalCredentialError);
    expect(read().accounts).toEqual([]);
  });

  it("does not save an old quota result after the account is reauthorized", async () => {
    write({ accounts: [{ ...account(), accessToken: "valid", accessTokenExpiresAt: Date.now() + 3600_000 }] });
    let finish!: (value: Response) => void;
    vi.mocked(codexUpstreamFetch).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const service = new CodexService({ dataDir: dir } as any, {} as any);
    const pending = service.refreshCodexAccountQuota({ accountId: 1 });
    await vi.waitFor(() => expect(codexUpstreamFetch).toHaveBeenCalledTimes(1));
    service.addCodexAccount({ email: "test@example.test", refreshToken: "new-login" });
    const newer = account();
    finish(new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 99 } } })));
    expect(await pending).toMatchObject({ ok: false });
    expect(account()).toEqual(newer);
    expect(newer.accessToken).toBeUndefined();
  });

  it("does not disable a new authorization when the old import probe fails", async () => {
    let fail!: (error: Error) => void;
    vi.mocked(codexUpstreamFetch).mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const service = new CodexService({ dataDir: dir } as any, {} as any);
    const pending = service.addCodexAccountChecked({ email: "test@example.test", refreshToken: "first-import" });
    service.addCodexAccount({ email: "test@example.test", refreshToken: "new-login" });
    fail(new Error("invalid_grant"));
    expect(await pending).toMatchObject({ tokenValid: false });
    expect(account()).toMatchObject({ refreshToken: "new-login", enabled: true });
  });

  it("reports a successful reset even if saving its cache invalidation fails", async () => {
    write({ accounts: [{ ...account(), accessToken: "valid", accessTokenExpiresAt: Date.now() + 3600_000 }] });
    vi.mocked(codexUpstreamFetch).mockResolvedValue(new Response("{}"));
    vi.spyOn(store, "writeJson").mockImplementationOnce(() => { throw new Error("disk full"); });
    const service = new CodexService({ dataDir: dir } as any, {} as any);
    const result = await service.consumeCodexResetCredit({ accountId: 1 });
    expect(result).toMatchObject({ ok: true });
    expect(result.quotaError).toContain("重置已成功");
    expect(codexUpstreamFetch).toHaveBeenCalledTimes(1);
  });
});
