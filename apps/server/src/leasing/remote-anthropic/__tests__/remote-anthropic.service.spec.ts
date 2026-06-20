import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { weeklyBucketKey } from "../../token-server/fair-share-tracker";
import { RemoteAnthropicService } from "../service/remote-anthropic.service";
import { sessionReqFor, withSessionResolver } from "../../token-server/__tests__/session-test-util";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("RemoteAnthropicService", () => {
  let tempDir: string;
  let accountsFilePath: string;
  let accessKeysFilePath: string;
  const tokenProvider = vi.fn();
  let currentTime: number;

  const MODEL = "claude-opus-4-20250514";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-remote-anthropic-"));
    accountsFilePath = path.join(tempDir, "claude-accounts.json");
    accessKeysFilePath = path.join(tempDir, "access-keys.json");
    currentTime = Date.parse("2026-05-29T01:00:00.000Z");
    tokenProvider.mockReset();

    writeJson(accountsFilePath, {
      accounts: [
        {
          id: 21,
          email: "claude-alpha@example.com",
          refreshToken: "refresh-alpha",
          enabled: true,
          planType: "max",
        },
      ],
    });
    writeJson(accessKeysFilePath, {
      keys: [
        {
          id: "claude-card-1",
          key: "claude-secret-card",
          status: "active",
          durationMs: 60 * 60 * 1000,
          windowLimit: 10,
        },
      ],
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeService() {
    return withSessionResolver(new RemoteAnthropicService({
      accountsFilePath,
      accessKeysFilePath,
      tokenProvider,
      now: () => currentTime,
      randomId: () => "claude-lease-fixed",
      minClientVersion: "",
    }));
  }

  it("returns independent claude account and card status", () => {
    const status = makeService().getStatus();

    expect(status.running).toBe(true);
    expect(status.mode).toBe("remote-anthropic-server");
    expect(status.activeLeases).toBe(0);
    expect(status.accounts.total).toBe(1);
    expect(status.accounts.enabled).toBe(1);
    expect(status.accessKeys.total).toBe(1);
    // Claude model catalog is surfaced in status.
    expect(status.models.some((m: any) => m.key === MODEL)).toBe(true);
  });

  it("rejects lease-token when the claude card header credential is presented (removed)", async () => {
    const service = makeService();

    await expect(
      service.leaseToken(
        { headers: { "x-token-server-secret": "bad-card" } },
        { clientId: "client-a", modelKey: MODEL },
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: "Missing access key" });
    expect(tokenProvider).not.toHaveBeenCalled();
  });

  it("leases a Claude OAuth access token from an enabled account", async () => {
    tokenProvider.mockResolvedValue("claude-access-token-alpha");
    const service = makeService();

    const result = await service.leaseToken(
      sessionReqFor("claude-card-1"),
      { clientId: "client-a", modelKey: MODEL, bodyBytes: 2500 },
    );

    expect(result.ok).toBe(true);
    expect(result.leaseId).toBe("claude-lease-fixed");
    expect(result.accountId).toBe(21);
    expect(result.accessToken).toBe("claude-access-token-alpha");
    expect(result.accessKeySessionId).toBeTruthy();
    // The provider now hands the refresher a disk re-reader (reload) so it can
    // adopt a token another writer just rotated instead of double-burning one.
    expect(tokenProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: 21, refreshToken: "refresh-alpha" }),
      expect.objectContaining({ reload: expect.any(Function) }),
    );
  });

  it("records usage against the claude card (opus bucket)", async () => {
    tokenProvider.mockResolvedValue("claude-access-token-alpha");
    const service = makeService();
    await service.leaseToken(
      sessionReqFor("claude-card-1"),
      { clientId: "client-a", modelKey: MODEL },
    );

    const report = await service.reportResult(
      sessionReqFor("claude-card-1"),
      {
        leaseId: "claude-lease-fixed",
        status: 200,
        modelKey: MODEL,
        inputTokens: 120,
        outputTokens: 40,
        totalTokens: 160,
      },
    );

    expect(report.ok).toBe(true);
    // 累计计数已下线;用量进入限流窗口(内存)+ CardUsageHourly(DB,本测试未接)。
    expect(report.accessKeyStatus.recentWindowTokens).toBe(160);
    expect((service as any).accessKeyStore.findById("claude-card-1").tokenUsageEvents.length).toBe(1);
  });

  it("feeds 5h and weekly fair-share windows from their own Claude quota fields", async () => {
    tokenProvider.mockResolvedValue("claude-access-token-alpha");
    const service = makeService();
    const lease = await service.leaseToken(
      sessionReqFor("claude-card-1"),
      { clientId: "client-a", modelKey: MODEL },
    );

    const hourlyReset = new Date(currentTime + 4 * 60 * 60 * 1000).toISOString();
    const weeklyReset = new Date(currentTime + 4 * 24 * 60 * 60 * 1000).toISOString();
    await service.reportResult(
      sessionReqFor("claude-card-1"),
      {
        leaseId: lease.leaseId,
        reportId: "quota-windows-1",
        status: 200,
        modelKey: MODEL,
        inputTokens: 100,
        outputTokens: 0,
        totalTokens: 100,
        accountQuota: {
          planType: "max",
          claudeQuota: {
            hourlyPercent: 90,
            weeklyPercent: 50,
            hourlyResetTime: hourlyReset,
            weeklyResetTime: weeklyReset,
          },
        },
      },
    );

    const bucket = "anthropic-claude";
    const short = service.fairShareTracker?.getBucketStateForTesting(21, bucket);
    const weekly = service.fairShareTracker?.getBucketStateForTesting(21, weeklyBucketKey(bucket));

    // 新模型只信上游剩余 fraction:5h/周快照各把「低水位」喂进对应窗口。
    expect(short?.lastFraction).toBeCloseTo(0.9, 5);
    expect(weekly?.lastFraction).toBeCloseTo(0.5, 5);
    // 冷启动首快照即对齐上游窗口:windowStart = 上游 resetAt − 窗口长度(可后移,见 CS4)→ 倒计时对齐上游真实剩余。
    expect(short?.windowStart).toBe(currentTime + 4 * 60 * 60 * 1000 - 5 * 60 * 60 * 1000); // reset 在 +4h → 起点 −1h
    expect(weekly?.windowStart).toBe(currentTime + 4 * 24 * 60 * 60 * 1000 - 7 * 24 * 60 * 60 * 1000); // reset 在 +4d → 起点 −3d
  });

  it("returns claudeWindows + accountBuckets on report so the client refreshes account-total without a fresh lease", async () => {
    tokenProvider.mockResolvedValue("claude-access-token-alpha");
    writeJson(accessKeysFilePath, {
      keys: [
        {
          id: "claude-card-1",
          key: "claude-secret-card",
          status: "active",
          durationMs: 60 * 60 * 1000,
          bindings: { anthropic: 21 },
        },
      ],
    });
    const service = makeService();
    const lease = await service.leaseToken(
      sessionReqFor("claude-card-1"),
      { clientId: "client-a", modelKey: MODEL },
    );
    const hourlyReset = new Date(currentTime + 4 * 60 * 60 * 1000).toISOString();
    const weeklyReset = new Date(currentTime + 4 * 24 * 60 * 60 * 1000).toISOString();
    const report = await service.reportResult(
      sessionReqFor("claude-card-1"),
      {
        leaseId: lease.leaseId,
        reportId: "acct-total-1",
        status: 200,
        modelKey: MODEL,
        inputTokens: 100,
        outputTokens: 0,
        totalTokens: 100,
        accountQuota: {
          planType: "max",
          claudeQuota: {
            hourlyPercent: 90,
            weeklyPercent: 50,
            hourlyResetTime: hourlyReset,
            weeklyResetTime: weeklyReset,
          },
        },
      },
    );
    // 账号总剩余两条路都随上报回带:claudeWindows(周血条唯一来源)+ accountBuckets(5h 兜底)。
    // 否则客户端只有「拿新号」那一下才更新整号余量,平时闪「未知」。响应是动态形状,断言时取 any。
    const r = report as any;
    expect(r.claudeWindows).toMatchObject({ hourlyPercent: 90, weeklyPercent: 50 });
    expect(Object.keys(r.accountBuckets ?? {})).toContain("anthropic-claude");
  });

  it("attributes a weekly account-consumption segment into the bound card's T_i", () => {
    // 重构后不再反推上游预算:周快照下降时,把这一段账号消耗 Δ = max(0, 低水位 − fraction)
    // 按本段各卡加权用量比例分摊进各人 T_i(只增不减)。绑卡是唯一参与者 → 整段归它。
    writeJson(accessKeysFilePath, {
      keys: [
        {
          id: "claude-card-1",
          key: "claude-secret-card",
          status: "active",
          durationMs: 60 * 60 * 1000,
          bindings: { anthropic: 21 },
        },
      ],
    });
    const service = makeService();
    const bucket = "anthropic-claude";

    // 首个快照先确立基线(冷启动采纳为低水位,不归账);随后真实下降才按段归账。
    service.fairShareTracker?.applyWeeklyAccountQuotaSnapshot(21, bucket, 1.0, 0);
    service.fairShareTracker?.recordUsage(21, "claude-card-1", bucket, 1_000_000, 0, 0, MODEL);
    service.fairShareTracker?.applyWeeklyAccountQuotaSnapshot(21, bucket, 0.5, 0);

    const weekly = service.fairShareTracker?.getBucketStateForTesting(21, weeklyBucketKey(bucket));
    expect(weekly?.lastFraction).toBeCloseTo(0.5, 5);
    // 低水位从 1.0 跌到 0.5 → Δ账号 = 0.5,全部记到唯一有用量的卡。
    expect(weekly?.attributed["claude-card-1"]).toBeCloseTo(0.5, 5);
    expect(weekly?.totalAttributed).toBeCloseTo(0.5, 5);
  });

  it("returns fair-share quota windows on lease-time 429 rejection", async () => {
    tokenProvider.mockResolvedValue("claude-access-token-alpha");
    writeJson(accessKeysFilePath, {
      keys: [
        {
          id: "claude-card-1",
          key: "claude-secret-card",
          status: "active",
          durationMs: 60 * 60 * 1000,
          bindings: { anthropic: 21 },
        },
      ],
    });
    const service = makeService();
    const bucket = "anthropic-claude";

    // 首个快照先确立基线(冷启动采纳,不归账);随后记一段大用量、5h/周各跌到 0.5 →
    // Δ账号 0.5 全归这张唯一参与卡的 T_i,远超其保证份额 e_i = w/D(1/max(N,Σw)) → 租号即被拦(429)。
    service.fairShareTracker?.applyAccountQuotaSnapshot(21, bucket, 1.0, 0);
    service.fairShareTracker?.applyWeeklyAccountQuotaSnapshot(21, bucket, 1.0, 0);
    service.fairShareTracker?.recordUsage(21, "claude-card-1", bucket, 1_000_000, 0, 0, MODEL);
    service.fairShareTracker?.applyAccountQuotaSnapshot(21, bucket, 0.5, 0);
    service.fairShareTracker?.applyWeeklyAccountQuotaSnapshot(21, bucket, 0.5, 0);

    await expect(
      service.leaseToken(
        sessionReqFor("claude-card-1"),
        { clientId: "client-a", modelKey: MODEL },
      ),
    ).rejects.toMatchObject({
      statusCode: 429,
      body: expect.objectContaining({
        fairShareQuota: expect.objectContaining({
          [bucket]: expect.objectContaining({ resetAt: expect.any(Number) }),
        }),
        weeklyFairShareQuota: expect.objectContaining({
          [bucket]: expect.objectContaining({ resetAt: expect.any(Number) }),
        }),
      }),
    });
    expect(tokenProvider).not.toHaveBeenCalled();
  });

  it("cools down a Claude account after a 429 quota status report", async () => {
    tokenProvider.mockResolvedValue("claude-access-token-alpha");
    const service = makeService();
    await service.leaseToken(
      sessionReqFor("claude-card-1"),
      { clientId: "client-a", modelKey: MODEL },
    );

    await service.reportResult(
      sessionReqFor("claude-card-1"),
      { leaseId: "claude-lease-fixed", status: 429, modelKey: MODEL },
    );

    tokenProvider.mockClear();
    await expect(
      service.leaseToken(
        sessionReqFor("claude-card-1"),
        { clientId: "client-a", modelKey: MODEL },
      ),
    ).rejects.toMatchObject({ statusCode: 503, message: "No available Claude accounts" });
    expect(tokenProvider).not.toHaveBeenCalled();
  });
});
