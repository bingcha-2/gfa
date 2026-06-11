import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../google-api", () => ({
  getAccessToken: vi.fn(async () => "tok"),
  fetchAccountHealth: vi.fn(),
  fetchAvailableModels: vi.fn(),
  extractTierFromModelsJson: vi.fn(() => ""),
  discoverProject: vi.fn(),
}));

import { CreditsQuotaService } from "../credits-quota.service";
import { discoverProject, extractTierFromModelsJson, fetchAccountHealth, fetchAvailableModels } from "../google-api";
import { readJson, writeJson } from "../lib/store";

let dir: string;
let ctx: any;
let svc: CreditsQuotaService;

const health = (planType = "pro") => ({
  credits: { known: true, available: true, creditAmount: 100, minCreditAmount: 0, paidTierID: "tier-x" },
  planType,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "credits-spec-"));
  ctx = { dataDir: dir, logger: { log: vi.fn(), warn: vi.fn() }, tokenCache: new Map() };
  svc = new CreditsQuotaService(ctx);
  vi.clearAllMocks();
  vi.mocked(extractTierFromModelsJson).mockReturnValue("");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const writeAccounts = (accounts: any[]) => writeJson(path.join(dir, "accounts.json"), { accounts });
const readAccounts = () => readJson(path.join(dir, "accounts.json"), { accounts: [] }).accounts;

describe("refreshCredits", () => {
  it("skips disabled / token-less accounts and refreshes the rest", async () => {
    writeAccounts([
      { id: 1, email: "a@x.com", refreshToken: "rt", projectId: "p1", planType: "free" },
      { id: 2, email: "b@x.com", refreshToken: "rt", projectId: "p2", enabled: false },
      { id: 3, email: "c@x.com", projectId: "p3" }, // no refreshToken
    ]);
    vi.mocked(fetchAccountHealth).mockResolvedValue(health("pro") as any);

    const r = await svc.refreshCredits();

    expect(r).toMatchObject({ ok: true, refreshed: 1, errors: 0, total: 1 });
    const acc = readAccounts().find((a: any) => a.id === 1);
    expect(acc.credits).toBeUndefined(); // credit 跟踪已整套移除,只保留 planType
    expect(acc.planType).toBe("pro"); // upgraded from "free"
  });

  it("clears quota blocks on a plan upgrade", async () => {
    writeAccounts([
      { id: 1, email: "a@x.com", refreshToken: "rt", projectId: "p1", planType: "free", quotaStatus: "exhausted", quotaStatusReason: "x", blockedModels: [{ modelKey: "m" }] },
    ]);
    vi.mocked(fetchAccountHealth).mockResolvedValue(health("pro") as any);

    await svc.refreshCredits();

    const acc = readAccounts()[0];
    expect(acc.quotaStatus).toBeUndefined();
    expect(acc.blockedModels).toEqual([]);
  });

  it("auto-discovers a missing projectId, erroring when none is found", async () => {
    writeAccounts([{ id: 1, email: "a@x.com", refreshToken: "rt" }]); // no projectId
    vi.mocked(discoverProject).mockResolvedValue({} as any); // discovery yields nothing

    const r = await svc.refreshCredits();

    expect(r).toMatchObject({ refreshed: 0, errors: 1 });
    expect(r.accounts[0]).toMatchObject({ error: "no projectId" });
    expect(fetchAccountHealth).not.toHaveBeenCalled();
  });

  it("records an error (and warns) when health fetch throws", async () => {
    writeAccounts([{ id: 1, email: "a@x.com", refreshToken: "rt", projectId: "p1" }]);
    vi.mocked(fetchAccountHealth).mockRejectedValue(new Error("upstream 500"));

    const r = await svc.refreshCredits();

    expect(r).toMatchObject({ refreshed: 0, errors: 1 });
    expect(r.accounts[0]).toMatchObject({ error: "upstream 500" });
    expect(ctx.logger.warn).toHaveBeenCalled();
  });
});

describe("refreshQuota", () => {
  it("writes per-model fractions + reset times (no quota-data.json)", async () => {
    writeAccounts([{ id: 1, email: "a@x.com", refreshToken: "rt", projectId: "p1", planType: "pro", alias: "Org" }]);
    vi.mocked(fetchAccountHealth).mockResolvedValue(health("pro") as any);
    vi.mocked(fetchAvailableModels).mockResolvedValue({
      rawJson: { raw: true },
      models: { "gemini-2.5-pro": { remainingFraction: 0.5, resetTime: "2030-01-01T00:00:00Z" } },
    } as any);

    const r = await svc.refreshQuota();

    expect(r).toMatchObject({ ok: true, refreshed: 1, errors: 0, total: 1 });
    const acc = readAccounts()[0];
    expect(acc.modelQuotaFractions).toEqual({ "gemini-2.5-pro": 0.5 });
    expect(acc.modelQuotaResetTimes).toEqual({ "gemini-2.5-pro": "2030-01-01T00:00:00Z" });
    // quota-data.json 已废弃:refreshQuota 不再写它。
    expect(fs.existsSync(path.join(dir, "quota-data.json"))).toBe(false);
  });

  it("auto-unblocks a quota-blocked model that now has quota and flips status to ok", async () => {
    writeAccounts([{
      id: 1, email: "a@x.com", refreshToken: "rt", projectId: "p1",
      quotaStatus: "exhausted", blockedModels: [{ reason: "quota", modelKey: "gemini-2.5-pro" }],
    }]);
    vi.mocked(fetchAccountHealth).mockResolvedValue(health("pro") as any);
    vi.mocked(fetchAvailableModels).mockResolvedValue({
      rawJson: {},
      models: { "gemini-2.5-pro": { remainingFraction: 0.8, resetTime: "" } },
    } as any);

    await svc.refreshQuota();

    const acc = readAccounts()[0];
    expect(acc.blockedModels).toEqual([]);
    expect(acc.quotaStatus).toBe("ok");
  });

  it("counts an error when fetchAvailableModels returns null", async () => {
    writeAccounts([{ id: 1, email: "a@x.com", refreshToken: "rt", projectId: "p1" }]);
    vi.mocked(fetchAccountHealth).mockResolvedValue(health("pro") as any);
    vi.mocked(fetchAvailableModels).mockResolvedValue(null as any);

    const r = await svc.refreshQuota();

    expect(r).toMatchObject({ refreshed: 0, errors: 1, total: 1 });
  });
});
