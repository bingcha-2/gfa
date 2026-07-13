// ─────────────────────────────────────────────────────────────────────────────
// Codex 额度端到端场景套(真链路:leaseToken → reportResult(accountQuota) →
// applyQuotaSnapshot → fair-share → 血条)。不是单元测试——每条都跑真实 RemoteCodexService,
// 复现一种线上情形,并作为回归护栏(以后改额度链任何一处,这套兜住)。
// 覆盖:超卖 / 上报额度变化 / 刷新+重置时间不延后(同窗口归并)/ 刷新+重置时间延后(真翻窗)/
// 多母号独立 / 不同模型同账号窗口 / 冷启动采纳不凭空扣 / 伪造100不进(-1未知)/ 换号接力串号被拒。
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RemoteCodexService } from "../service/remote-codex.service";
import { sessionReqFor, withSessionResolver } from "../../token-server/__tests__/session-test-util";
import { weeklyBucketKey } from "../../token-server/fair-share-tracker";

const BK = "codex-gpt";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function writeJson(p: string, v: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, "utf8");
}

describe("Codex 额度 E2E 场景", () => {
  let dir: string, accountsFile: string, keysFile: string, now: number, leaseSeq: number;
  const tokenProvider = vi.fn();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-codex-e2e-"));
    accountsFile = path.join(dir, "codex-accounts.json");
    keysFile = path.join(dir, "access-keys.json");
    now = Date.parse("2026-05-29T01:00:00.000Z");
    leaseSeq = 0;
    tokenProvider.mockReset();
    tokenProvider.mockResolvedValue("codex-access-token");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 建号池 + 卡(每卡可带 bindings 死绑某母号 + weight)。
  function setup(accounts: any[], cards: any[]): any {
    writeJson(accountsFile, { accounts });
    writeJson(keysFile, { keys: cards });
    return withSessionResolver(new RemoteCodexService({
      accountsFilePath: accountsFile, accessKeysFilePath: keysFile, tokenProvider,
      now: () => now, randomId: () => `lease-${++leaseSeq}`, minClientVersion: "",
      fairShareAlgorithm: "segment-v1", // explicit rollback-path compatibility suite
    }));
  }
  const acct = (id: number, extra: any = {}) => ({ id, email: `a${id}@x.com`, refreshToken: `rt-${id}`, enabled: true, planType: "pro", ...extra });
  const card = (id: number, accountId: number, weight = 1) => ({ id: `card-${id}`, key: `secret-${id}`, status: "active", durationMs: HOUR, bindings: { codex: accountId }, weight });

  // 租号 + 上报(可带 accountQuota)。
  async function lease(svc: any, cardId: string, modelKey = "gpt-5-codex") {
    return svc.leaseToken(sessionReqFor(cardId), { clientId: cardId, modelKey });
  }
  async function report(svc: any, cardId: string, leaseId: string, opts: any) {
    return svc.reportResult(sessionReqFor(cardId), {
      leaseId, reportId: `${leaseId}-r${Math.random()}`, status: 200, modelKey: opts.modelKey || "gpt-5-codex",
      inputTokens: opts.input ?? 0, outputTokens: opts.output ?? 0, totalTokens: (opts.input ?? 0) + (opts.output ?? 0),
      ...(opts.accountQuota ? { accountQuota: opts.accountQuota } : {}),
    });
  }
  // 上游额度 snapshot（客户端上报格式，含 accountId = 探自哪个号）。
  const quota = (accountId: number, h: number, w: number, hReset?: string, wReset?: string, presence?: { hourlyPresent?: boolean; weeklyPresent?: boolean }) => ({
    accountId, planType: "pro",
    codexQuota: { hourlyPercent: h, weeklyPercent: w, ...(hReset ? { hourlyResetTime: hReset } : {}), ...(wReset ? { weeklyResetTime: wReset } : {}), ...presence },
  });
  const fair = (svc: any, accountId: number, bucket = BK) => svc.fairShareTracker.getBucketStateForTesting(accountId, bucket);

  // ── 上报额度变化 / 远程刷新 ────────────────────────────────────────────────
  it("上报额度变化:5h/周低水位随真实上报下降", async () => {
    const svc = setup([acct(11)], [card(1, 11)]);
    const l = await lease(svc, "card-1");
    await report(svc, "card-1", l.leaseId, { input: 100, accountQuota: quota(11, 90, 60, new Date(now + 4 * HOUR).toISOString(), new Date(now + 4 * DAY).toISOString()) });
    expect(fair(svc, 11).lastFraction).toBeCloseTo(0.9, 5);
    expect(fair(svc, 11, weeklyBucketKey(BK)).lastFraction).toBeCloseTo(0.6, 5);
    // 再降
    const l2 = await lease(svc, "card-1");
    await report(svc, "card-1", l2.leaseId, { input: 100, accountQuota: quota(11, 55, 60, new Date(now + 4 * HOUR).toISOString(), new Date(now + 4 * DAY).toISOString()) });
    expect(fair(svc, 11).lastFraction).toBeCloseTo(0.55, 5);
  });

  // ── 刷新+重置时间不延后 → 同一窗口归并(账号跌幅记进 T) ──────────────────
  it("刷新+重置时间不延后:同窗口内下降 → Δ归并进绑卡 T", async () => {
    const hReset = new Date(now + 4 * HOUR).toISOString();
    const svc = setup([acct(11)], [card(1, 11)]);
    let l = await lease(svc, "card-1");
    await report(svc, "card-1", l.leaseId, { input: 100, accountQuota: quota(11, 90, 90, hReset) });
    l = await lease(svc, "card-1");
    await report(svc, "card-1", l.leaseId, { input: 100, accountQuota: quota(11, 60, 90, hReset) }); // 同 reset,降到 60
    const st = fair(svc, 11);
    expect(st.lastFraction).toBeCloseTo(0.6, 5);
    expect(st.attributed["card-1"]).toBeGreaterThan(0); // 账号跌了 0.3 → 归绑卡(唯一在场)
  });

  // ── 刷新+重置时间延后 → 真翻窗(清 T,新低水位) ──────────────────────────
  it("刷新+重置时间延后一整窗:判为新窗口 → T 清零、低水位取新值", async () => {
    const svc = setup([acct(11)], [card(1, 11)]);
    let l = await lease(svc, "card-1");
    await report(svc, "card-1", l.leaseId, { input: 100, accountQuota: quota(11, 40, 90, new Date(now + 1 * HOUR).toISOString()) });
    expect(fair(svc, 11).lastFraction).toBeCloseTo(0.4, 5); // 冷启动采纳 40%
    // reset 前移一整个 5h 窗口 + fraction 回满 → 新窗口
    now += 2 * HOUR;
    l = await lease(svc, "card-1");
    await report(svc, "card-1", l.leaseId, { input: 10, accountQuota: quota(11, 98, 90, new Date(now + 5 * HOUR).toISOString()) });
    const st = fair(svc, 11);
    expect(st.lastFraction).toBeCloseTo(0.98, 5);
    expect(st.attributed["card-1"] ?? 0).toBe(0); // 翻窗清 T
  });

  // ── 超卖:同号多卡,各自份额;某卡烧完自己那份被拦,不吃别人的 ──────────────
  it("超卖:同号两张卡各占份额;重度卡烧完自己那份被闸拦,轻度卡不受影响", async () => {
    const svc = setup([acct(11)], [card(1, 11, 1), card(2, 11, 1)]);
    // 建窗
    let l1 = await lease(svc, "card-1");
    await report(svc, "card-1", l1.leaseId, { input: 10, accountQuota: quota(11, 100, 100) });
    const share1 = svc.fairShareTracker.getCardQuotaFractions(11, "card-1")[BK]?.share;
    expect(share1).toBeGreaterThan(0);
    expect(share1).toBeLessThanOrEqual(0.5); // 两卡分摊,各 ≤ 0.5(超卖被摊薄)
    // card-1 疯狂烧,账号真跌 → 归 card-1
    l1 = await lease(svc, "card-1");
    await report(svc, "card-1", l1.leaseId, { input: 1_000_000, accountQuota: quota(11, 5, 100) });
    // card-1 自己那份用完 → 取号被拦;card-2 没用过,仍可租
    const c1 = svc.fairShareTracker.checkFairShare(11, "card-1", BK);
    const c2 = svc.fairShareTracker.checkFairShare(11, "card-2", BK);
    expect(c1.allowed).toBe(false);
    expect(c2.allowed).toBe(true);
  });

  // ── 多母号:两号各自独立,互不串 ─────────────────────────────────────────
  it("多母号并存:各自低水位独立,不互相污染", async () => {
    const svc = setup([acct(11), acct(22)], [card(1, 11), card(2, 22)]);
    const la = await lease(svc, "card-1"); await report(svc, "card-1", la.leaseId, { input: 10, accountQuota: quota(11, 30, 30) });
    const lb = await lease(svc, "card-2"); await report(svc, "card-2", lb.leaseId, { input: 10, accountQuota: quota(22, 80, 80) });
    expect(fair(svc, 11).lastFraction).toBeCloseTo(0.3, 5);
    expect(fair(svc, 22).lastFraction).toBeCloseTo(0.8, 5);
  });

  // ── 不同模型:codex 额度是账号级(非按模型),不同模型喂同一个 codex 窗口 ────
  it("不同模型上报:codex 额度账号级,gpt-5-codex 与 gpt-5.2-codex 落同一窗口", async () => {
    const svc = setup([acct(11)], [card(1, 11)]);
    let l = await lease(svc, "card-1", "gpt-5-codex");
    await report(svc, "card-1", l.leaseId, { modelKey: "gpt-5-codex", input: 10, accountQuota: quota(11, 70, 70) });
    l = await lease(svc, "card-1", "gpt-5.2-codex");
    await report(svc, "card-1", l.leaseId, { modelKey: "gpt-5.2-codex", input: 10, accountQuota: quota(11, 50, 70) });
    // 两个模型都写进 "codex-gpt" 这一个账号级窗口
    expect(fair(svc, 11).lastFraction).toBeCloseTo(0.5, 5);
  });

  // ── 回归①:伪造100不进(客户端上游缺字段报 -1)→ 保留上次真实值 ────────────
  it("回归·未知(-1)不覆盖:上游缺窗口时上报 -1 → 保留上次真实值,不伪装满血", async () => {
    const svc = setup([acct(11)], [card(1, 11)]);
    let l = await lease(svc, "card-1");
    await report(svc, "card-1", l.leaseId, { input: 10, accountQuota: quota(11, 46, 46) });
    l = await lease(svc, "card-1");
    await report(svc, "card-1", l.leaseId, { input: 10, accountQuota: quota(11, -1, -1) }); // 未知
    expect(fair(svc, 11).lastFraction).toBeCloseTo(0.46, 5); // 没被 -1 或伪造100 覆盖
  });

  it("回归·5h窗口明确消失:清掉旧主窗口闸门,只保留周窗口", async () => {
    const svc = setup([acct(11)], [card(1, 11)]);
    const l = await lease(svc, "card-1");
    await report(svc, "card-1", l.leaseId, {
      input: 10,
      accountQuota: quota(11, 0, 80, new Date(now + 4 * HOUR).toISOString(), new Date(now + 4 * DAY).toISOString()),
    });
    expect(svc.fairShareTracker.getCardQuotaFractions(11, "card-1")[BK]).toBeDefined();

    await report(svc, "card-1", l.leaseId, {
      input: 0,
      accountQuota: quota(11, -1, 72, undefined, new Date(now + 4 * DAY).toISOString(), {
        hourlyPresent: false,
        weeklyPresent: true,
      }),
    });

    expect(svc.fairShareTracker.getCardQuotaFractions(11, "card-1")).toEqual({});
    expect(svc.fairShareTracker.getCardWeeklyQuotaFractions(11, "card-1")[BK]).toBeDefined();
    expect(svc.fairShareTracker.checkFairShare(11, "card-1", BK).allowed).toBe(true);
    await expect(lease(svc, "card-1")).resolves.toMatchObject({ accountId: 11 });
  });

  it("回归·乱序 presence:旧双窗口快照不能复活较新的 weekly-only 状态", async () => {
    const svc = setup([acct(11)], [card(1, 11)]);
    const l = await lease(svc, "card-1");
    await report(svc, "card-1", l.leaseId, {
      accountQuota: {
        ...quota(11, -1, 72, undefined, undefined, { hourlyPresent: false, weeklyPresent: true }),
        fetchedAt: now - 10,
      },
    });
    await report(svc, "card-1", l.leaseId, {
      accountQuota: {
        ...quota(11, 90, 90, undefined, undefined, { hourlyPresent: true, weeklyPresent: true }),
        fetchedAt: now - 20,
      },
    });

    expect(svc.fairShareTracker.getCardQuotaFractions(11, "card-1")).toEqual({});
    expect(fair(svc, 11)).toBeNull();
    svc.flushAccounts();
    const stored = JSON.parse(fs.readFileSync(accountsFile, "utf8")).accounts[0];
    expect(stored.codexHourlyPresent).toBe(false);
    expect(stored.codexHourlyPercent).toBeUndefined();
    const nextLease = await lease(svc, "card-1");
    expect(nextLease.codexWindows).toMatchObject({ hourlyPresent: false, weeklyPresent: true, weeklyPercent: 72 });
  });

  // ── 回归②:换号接力串号被拒(本轮线上真 bug)────────────────────────────
  it("回归·跨账号:换号后带上一个号的额度上报 → 被拒,当前号不被污染", async () => {
    const svc = setup([acct(11), acct(22)], [card(1, 11)]);
    // card-1 死绑 11,先建真实低水位 40
    let l = await lease(svc, "card-1");
    await report(svc, "card-1", l.leaseId, { input: 10, accountQuota: quota(11, 40, 40) });
    expect(fair(svc, 11).lastFraction).toBeCloseTo(0.4, 5);
    // 模拟换号接力遗留:上报带【探自账号 22】的额度(98/100),但当前写的是账号 11
    l = await lease(svc, "card-1");
    await report(svc, "card-1", l.leaseId, { input: 10, accountQuota: quota(22, 98, 100) }); // accountId=22 ≠ 11
    // 账号 11 保持真实 0.4,没被账号 22 的 0.98 污染
    expect(fair(svc, 11).lastFraction).toBeCloseTo(0.4, 5);
  });
});
