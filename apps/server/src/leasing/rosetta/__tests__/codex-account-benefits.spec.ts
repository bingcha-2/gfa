import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ token: vi.fn(), subscription: vi.fn(), credits: vi.fn(), consume: vi.fn() }));
vi.mock("../../remote-codex/auth/codex-token-provider", () => ({ refreshCodexAccessToken: mocks.token }));
vi.mock("../../remote-codex/auth/codex-subscription", async (original) => ({
  ...await original<any>(), fetchCodexSubscription: mocks.subscription,
}));
vi.mock("../../remote-codex/auth/codex-reset-credits", () => ({ fetchCodexResetCredits: mocks.credits, consumeCodexResetCredit: mocks.consume }));
import { CodexService } from "../codex.service";

describe("Codex benefits refresh", () => {
  let dir: string;
  let file: string;
  let service: CodexService;
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const write = (data: any) => fs.writeFileSync(file, JSON.stringify(data));
  beforeEach(() => {
    vi.resetAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-benefits-"));
    file = path.join(dir, "codex-accounts.json");
    write({ accounts: [{ id: 1, email: "owner@example.com", proxyUrl: "http://proxy:1", accessToken: "old", refreshToken: "rt" }] });
    service = new CodexService({ dataDir: dir } as any, {
      boundCardCounts: () => new Map(), boundSharesByAccount: () => new Map(),
    } as any);
    mocks.token.mockImplementation(async (acc) => { acc.refreshToken = "rotated"; acc.accessTokenExpiresAt = 500; return "fresh"; });
    mocks.subscription.mockResolvedValue({ expiresAt: "2100-01-01T00:00:00.000Z" });
    mocks.credits.mockResolvedValue({ availableCount: 0, nextExpiresAt: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists expiry for the list and queries both sources with the account proxy", async () => {
    const result = await service.queryCodexAccountBenefits({ accountId: 1 });
    expect(result.resetCredits.availableCount).toBe(0);
    expect(mocks.subscription).toHaveBeenCalledWith("fresh", "http://proxy:1");
    expect(mocks.credits).toHaveBeenCalledWith("fresh", "http://proxy:1");
    const stored = read().accounts[0];
    expect(stored.refreshToken).toBe("rotated");
    expect(stored.subscriptionExpiresAt).toBe("2100-01-01T00:00:00.000Z");
    const listed = service.listCodexAccounts().accounts[0];
    expect(listed.subscriptionExpiresAt).toBe(stored.subscriptionExpiresAt);
    expect(listed).not.toHaveProperty("accessToken");
    expect(listed).not.toHaveProperty("refreshToken");
  });
  it("preserves an old expiry on failure while exposing a valid reset count", async () => {
    const saved = read();
    saved.accounts[0].subscriptionExpiresAt = "2026-09-11T00:00:00.000Z";
    saved.accounts[0].subscriptionCheckedAt = 123;
    write(saved);
    mocks.subscription.mockRejectedValue(new Error("403 secret"));
    mocks.credits.mockResolvedValue({ availableCount: 3 });
    const result = await service.queryCodexAccountBenefits({ accountId: 1 });
    expect(result.subscriptionExpiresAt).toBe("2026-09-11T00:00:00.000Z");
    expect(result.subscriptionCheckedAt).toBe(123);
    expect(result.subscriptionError).toBeTruthy();
    expect(result.resetCredits.availableCount).toBe(3);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("does not turn a failed credit query into zero and keeps concurrent edits", async () => {
    mocks.subscription.mockImplementation(async () => {
      const concurrent = read();
      concurrent.accounts[0].alias = "edited while loading";
      concurrent.accounts.push({ id: 2, email: "new@example.com" });
      write(concurrent);
      return { expiresAt: null };
    });
    mocks.credits.mockRejectedValue(new Error("network"));
    const result = await service.queryCodexAccountBenefits({ accountId: 1 });
    expect(result.resetCredits.availableCount).toBeNull();
    expect(result.resetCredits.error).toBeTruthy();
    expect(result.subscriptionError).toBe("");
    expect(read().accounts).toHaveLength(2);
    expect(read().accounts[0].alias).toBe("edited while loading");
  });
  it("deduplicates simultaneous refreshes of one mother account", async () => {
    await Promise.all([service.queryCodexAccountBenefits({ accountId: 1 }), service.queryCodexAccountBenefits({ accountId: 1 })]);
    expect(mocks.token).toHaveBeenCalledTimes(1);
    expect(mocks.subscription).toHaveBeenCalledTimes(1);
  });
  it("returns a credential error without querying upstream benefits", async () => {
    mocks.token.mockRejectedValue(new Error("private token details"));
    const result = await service.queryCodexAccountBenefits({ accountId: 1 });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(mocks.credits).not.toHaveBeenCalled();
  });

  it("reuses the persisted cache on reopen without token or upstream requests", async () => {
    await service.queryCodexAccountBenefits({ accountId: 1 });
    const reopened = new CodexService({ dataDir: dir } as any, {} as any);
    const cached = await reopened.queryCodexAccountBenefits({ accountId: 1 });
    expect(cached.updated).toBe(false);
    expect(cached.resetCredits.availableCount).toBe(0);
    expect(cached.resetCredits.checkedAt).toBeGreaterThan(0);
    expect(mocks.token).toHaveBeenCalledTimes(1);
    expect(mocks.subscription).toHaveBeenCalledTimes(1);
    expect(mocks.credits).toHaveBeenCalledTimes(1);
  });

  it("refreshes only credits after one hour, and both after six hours", async () => {
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    await service.queryCodexAccountBenefits({ accountId: 1 });
    clock.mockReturnValue(start + 60 * 60 * 1000);
    await service.queryCodexAccountBenefits({ accountId: 1 });
    expect(mocks.subscription).toHaveBeenCalledTimes(1);
    expect(mocks.credits).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(start + 6 * 60 * 60 * 1000);
    await service.queryCodexAccountBenefits({ accountId: 1 });
    expect(mocks.subscription).toHaveBeenCalledTimes(2);
    expect(mocks.credits).toHaveBeenCalledTimes(3);
  });

  it("manual refresh bypasses both fresh caches", async () => {
    await service.queryCodexAccountBenefits({ accountId: 1 });
    await service.queryCodexAccountBenefits({ accountId: 1, force: true });
    expect(mocks.subscription).toHaveBeenCalledTimes(2);
    expect(mocks.credits).toHaveBeenCalledTimes(2);
  });

  it("does not retain credit or subscription data across its known expiry", async () => {
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    mocks.subscription.mockResolvedValue({ expiresAt: new Date(start + 30_000).toISOString() });
    mocks.credits.mockResolvedValue({ availableCount: 1, nextExpiresAt: Math.floor((start + 30_000) / 1000) });
    await service.queryCodexAccountBenefits({ accountId: 1 });
    clock.mockReturnValue(start + 31_000);
    mocks.credits.mockResolvedValue({ availableCount: 0 });
    const result = await service.queryCodexAccountBenefits({ accountId: 1 });
    expect(mocks.subscription).toHaveBeenCalledTimes(2);
    expect(result.resetCredits.availableCount).toBe(0);
  });

  it("backs off failed queries for five minutes but lets manual retry through", async () => {
    mocks.credits.mockRejectedValue(new Error("network"));
    await service.queryCodexAccountBenefits({ accountId: 1 });
    const cached = await service.queryCodexAccountBenefits({ accountId: 1 });
    expect(cached.resetCredits.availableCount).toBeNull();
    expect(cached.resetCredits.error).toBeTruthy();
    expect(mocks.credits).toHaveBeenCalledTimes(1);
    await service.queryCodexAccountBenefits({ accountId: 1, force: true });
    expect(mocks.credits).toHaveBeenCalledTimes(2);
  });

  it("invalidates credit cache after consume without discarding subscription cache", async () => {
    mocks.credits.mockResolvedValue({ availableCount: 3 });
    await service.queryCodexAccountBenefits({ accountId: 1 });
    vi.spyOn(service, "refreshCodexAccountQuota").mockResolvedValue({ ok: true } as any);
    mocks.consume.mockResolvedValue(undefined);
    expect((await service.consumeCodexResetCredit({ accountId: 1 })).ok).toBe(true);
    expect(read().accounts[0].resetCreditsCheckedAt).toBe(0);
    mocks.credits.mockResolvedValue({ availableCount: 2 });
    const updated = await service.queryCodexAccountBenefits({ accountId: 1 });
    expect(updated.resetCredits.availableCount).toBe(2);
    expect(mocks.subscription).toHaveBeenCalledTimes(1);
  });

  it("does not let an in-flight pre-consume response repopulate the credit cache", async () => {
    let finish!: (value: any) => void;
    mocks.credits.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = service.queryCodexAccountBenefits({ accountId: 1 });
    await vi.waitFor(() => expect(mocks.credits).toHaveBeenCalledTimes(1));
    vi.spyOn(service, "refreshCodexAccountQuota").mockResolvedValue({ ok: true } as any);
    mocks.consume.mockResolvedValue(undefined);
    await service.consumeCodexResetCredit({ accountId: 1 });
    finish({ availableCount: 3 });
    expect((await pending).resetCredits.availableCount).toBeNull();
    expect(read().accounts[0].resetCreditsCheckedAt).toBe(0);
    mocks.credits.mockResolvedValue({ availableCount: 2 });
    expect((await service.queryCodexAccountBenefits({ accountId: 1 })).resetCredits.availableCount).toBe(2);
  });
});
