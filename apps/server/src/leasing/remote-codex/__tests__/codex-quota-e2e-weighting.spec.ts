// ─────────────────────────────────────────────────────────────────────────────
// Codex 额度端到端 · 权重 / 超卖 / 窗口独立 场景套(真链路回归)。
// 覆盖:快速档乘数多扣份额、缓存 token 权重低少扣、5h 与周窗口相互独立、
// 真·耗尽 0(vs 未知 -1)、拼车 scale 封顶(我的总剩余 ≤ 账号)。
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

function writeJson(p: string, v: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, "utf8");
}

describe("Codex 额度 E2E · 权重/超卖/窗口独立", () => {
  let dir: string, accountsFile: string, keysFile: string, now: number, seq: number;
  let lastLease: Record<string, string>;
  const tokenProvider = vi.fn();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-codex-e2e-w-"));
    accountsFile = path.join(dir, "codex-accounts.json");
    keysFile = path.join(dir, "access-keys.json");
    now = Date.parse("2026-05-29T01:00:00.000Z");
    seq = 0; lastLease = {};
    tokenProvider.mockReset(); tokenProvider.mockResolvedValue("tok");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function setup(accounts: any[], cards: any[]): any {
    writeJson(accountsFile, { accounts });
    writeJson(keysFile, { keys: cards });
    return withSessionResolver(new RemoteCodexService({
      accountsFilePath: accountsFile, accessKeysFilePath: keysFile, tokenProvider,
      now: () => now, randomId: () => `lease-${++seq}`, minClientVersion: "",
      fairShareAlgorithm: "segment-v1", // explicit rollback-path compatibility suite
    }));
  }
  const acct = (id: number) => ({ id, email: `a${id}@x.com`, refreshToken: `rt-${id}`, enabled: true, planType: "pro" });
  const card = (id: number, accountId: number, weight = 1) => ({ id: `card-${id}`, key: `s-${id}`, status: "active", durationMs: HOUR, bindings: { codex: accountId }, weight });
  const quota = (accountId: number, h: number, w: number, hReset?: string, wReset?: string) => ({
    accountId, planType: "pro",
    codexQuota: { hourlyPercent: h, weeklyPercent: w, ...(hReset ? { hourlyResetTime: hReset } : {}), ...(wReset ? { weeklyResetTime: wReset } : {}) },
  });
  async function push(svc: any, cardId: string, opts: any) {
    let leaseId: string;
    try {
      const l = await svc.leaseToken(sessionReqFor(cardId), { clientId: cardId, modelKey: "gpt-5-codex" });
      leaseId = l.leaseId; lastLease[cardId] = leaseId;
    } catch (e) { leaseId = lastLease[cardId]; if (!leaseId) throw e; }
    await svc.reportResult(sessionReqFor(cardId), {
      leaseId, reportId: `${leaseId}-${Math.random()}`, status: 200, modelKey: "gpt-5-codex",
      inputTokens: opts.input ?? 0, outputTokens: opts.output ?? 0, cachedInputTokens: opts.cache ?? 0,
      totalTokens: (opts.input ?? 0) + (opts.output ?? 0),
      ...(opts.tier ? { serviceTier: opts.tier } : {}),
      ...(opts.q ? { accountQuota: opts.q } : {}),
    });
  }
  const fair = (svc: any, accountId: number, bucket = BK) => svc.fairShareTracker.getBucketStateForTesting(accountId, bucket);
  const T = (svc: any, accountId: number, cardId: string, bucket = BK) => fair(svc, accountId, bucket).attributed[cardId] ?? 0;

  // ── 快速档乘数:同 token,priority 档比普通档多扣份额 ──────────────────────
  it("快速档:同 token,serviceTier=priority 的卡多扣份额(分账占比更大)", async () => {
    const svc = setup([acct(11)], [card(1, 11, 1), card(2, 11, 1)]);
    await push(svc, "card-1", { input: 10, q: quota(11, 100, 100) }); // 建窗
    // 同一段:card-1 快速档、card-2 普通档,原始 token 相同
    await push(svc, "card-1", { input: 1000, tier: "priority" });
    await push(svc, "card-2", { input: 1000 });
    // 账号真跌 → delta 按加权用量分摊;快速档乘数 >1 → card-1 加权更高 → 分得更多
    await push(svc, "card-1", { input: 0, q: quota(11, 50, 100) });
    expect(T(svc, 11, "card-1")).toBeGreaterThan(T(svc, 11, "card-2"));
  });

  // ── 缓存权重低:同原始 token,缓存重的卡少扣份额 ──────────────────────────
  it("缓存权重低:同 token 量,缓存重的卡加权成本低 → 分得的账号跌幅更少", async () => {
    const svc = setup([acct(11)], [card(1, 11, 1), card(2, 11, 1)]);
    await push(svc, "card-1", { input: 10, q: quota(11, 100, 100) });
    // card-1 全净输入;card-2 同量但绝大多数是缓存读(权重 0.1)
    await push(svc, "card-1", { input: 10000 });
    await push(svc, "card-2", { input: 10000, cache: 9900 });
    await push(svc, "card-1", { input: 0, q: quota(11, 50, 100) });
    expect(T(svc, 11, "card-1")).toBeGreaterThan(T(svc, 11, "card-2")); // 净输入卡吃更多
  });

  // ── 5h 与周窗口相互独立 ────────────────────────────────────────────────────
  it("窗口独立:5h 高、周低 → 5h 低水位高、周低水位低,互不影响", async () => {
    const svc = setup([acct(11)], [card(1, 11)]);
    await push(svc, "card-1", { input: 10, q: quota(11, 90, 15, new Date(now + 4 * HOUR).toISOString(), new Date(now + 4 * 24 * HOUR).toISOString()) });
    expect(fair(svc, 11).lastFraction).toBeCloseTo(0.9, 5);
    expect(fair(svc, 11, weeklyBucketKey(BK)).lastFraction).toBeCloseTo(0.15, 5);
  });

  // ── 真·耗尽 0(vs 未知 -1):真0 会拦号,-1 不动 ───────────────────────────
  it("真0耗尽:上报 hourlyPercent=0(真耗尽)→ 低水位 0 且取号被拦(区别于未知 -1)", async () => {
    const svc = setup([acct(11)], [card(1, 11)]);
    await push(svc, "card-1", { input: 10, q: quota(11, 100, 100) });
    await push(svc, "card-1", { input: 10, q: quota(11, 0, 100) }); // 真·5h 耗尽
    expect(fair(svc, 11).lastFraction).toBeCloseTo(0, 5);
    expect(svc.fairShareTracker.checkFairShare(11, "card-1", BK).allowed).toBe(false); // 账号 0 → 拦
  });

  // ── 拼车 scale 封顶:账号被烧低时,单卡「我的总剩余」不超账号余量 ────────────
  it("拼车 scale 封顶:账号真跌到 20% → 各卡血条被账号余量封顶(≤ 0.2)", async () => {
    const svc = setup([acct(11)], [card(1, 11, 1), card(2, 11, 1)]);
    await push(svc, "card-1", { input: 10, q: quota(11, 100, 100) });
    // 账号被 card-1 烧到 20%
    await push(svc, "card-1", { input: 1_000_000, q: quota(11, 20, 100) });
    // card-2 没怎么用,但账号只剩 20% → 它的血条被 scale 封顶,不超 0.2/自身份额
    const bars = svc.fairShareTracker.getCardQuotaFractions(11, "card-2");
    if (bars[BK]) {
      // bloodBar 已按账号余量 scale 缩放:我的总剩余(= 名义份额 × bloodBar)不该超过账号 0.2
      const nominal = bars[BK].share; // 名义份额
      expect(nominal * bars[BK].fraction).toBeLessThanOrEqual(0.2 + 1e-6);
    }
  });
});
