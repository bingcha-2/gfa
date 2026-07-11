// ─────────────────────────────────────────────────────────────────────────────
// Codex 额度端到端 · 时序 / 额度走向 / 抖动 场景套(真链路回归)。
// 覆盖:上报晚了(乱序、迟到旧值)、先增后减、先减后增(单条不采纳 / 持续采纳)、
// 抖动(交错高值被拒 → 不抖)、不抖动(平滑单调)、幂等(重复上报不重复扣)、
// 自计时翻窗(离线跨窗口)、账号回血 T 退还。
// 每条跑真实 RemoteCodexService,断言的是真实系统行为——预期错=系统跟想的不一样,就地暴露。
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RemoteCodexService } from "../service/remote-codex.service";
import { sessionReqFor, withSessionResolver } from "../../token-server/__tests__/session-test-util";

const BK = "codex-gpt";
const HOUR = 60 * 60 * 1000;

function writeJson(p: string, v: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, "utf8");
}

describe("Codex 额度 E2E · 时序/走向/抖动", () => {
  let dir: string, accountsFile: string, keysFile: string, now: number, seq: number;
  let lastLease: Record<string, string>;
  const tokenProvider = vi.fn();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-codex-e2e-t-"));
    accountsFile = path.join(dir, "codex-accounts.json");
    keysFile = path.join(dir, "access-keys.json");
    now = Date.parse("2026-05-29T01:00:00.000Z");
    seq = 0;
    lastLease = {};
    tokenProvider.mockReset();
    tokenProvider.mockResolvedValue("tok");
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
  const quota = (accountId: number, h: number, w: number, hReset?: string) => ({
    accountId, planType: "pro",
    codexQuota: { hourlyPercent: h, weeklyPercent: w, ...(hReset ? { hourlyResetTime: hReset } : {}) },
  });
  // 租号 + 上报。若卡已被公平限额闸拦(leaseToken 抛「公平限额已用完」),回退复用上次租约继续上报
  // ——上报额度不受闸限制,只有租号受限;真实客户端也是持有租约期间持续上报。
  async function push(svc: any, cardId: string, opts: any) {
    let leaseId: string;
    try {
      const l = await svc.leaseToken(sessionReqFor(cardId), { clientId: cardId, modelKey: "gpt-5-codex" });
      leaseId = l.leaseId; lastLease[cardId] = leaseId;
    } catch (e) {
      leaseId = lastLease[cardId];
      if (!leaseId) throw e;
    }
    await svc.reportResult(sessionReqFor(cardId), {
      leaseId, reportId: `${leaseId}-${Math.random()}`, status: 200, modelKey: "gpt-5-codex",
      inputTokens: opts.input ?? 0, outputTokens: 0, totalTokens: opts.input ?? 0,
      ...(opts.q ? { accountQuota: opts.q } : {}),
    });
  }
  const fair = (svc: any, accountId: number, bucket = BK) => svc.fairShareTracker.getBucketStateForTesting(accountId, bucket);

  // ── 上报晚了 / 乱序 ────────────────────────────────────────────────────────
  it("乱序:真低值到达后,一条更高的旧上报晚到(单条)→ 低水位不被抬回", async () => {
    const svc = setup([acct(11)], [card(1, 11)]);
    await push(svc, "card-1", { input: 10, q: quota(11, 40, 40) });
    expect(fair(svc, 11).lastFraction).toBeCloseTo(0.4, 5);
    await push(svc, "card-1", { input: 10, q: quota(11, 90, 90) }); // 单条高值(晚到的旧值)
    expect(fair(svc, 11).lastFraction).toBeCloseTo(0.4, 5); // 回升需确认,单条不采纳
  });

  // ── 先减后增(单条不采纳 vs 持续采纳 + 退还) ─────────────────────────────
  it("先减后增·单条:降立即,单条升不采纳(保持低值)", async () => {
    const svc = setup([acct(11)], [card(1, 11)]);
    await push(svc, "card-1", { input: 10, q: quota(11, 30, 30) });
    await push(svc, "card-1", { input: 10, q: quota(11, 80, 80) });
    expect(fair(svc, 11).lastFraction).toBeCloseTo(0.3, 5);
  });

  it("先减后增·持续:回升满足 5min+2次确认 → 采纳,且已归因 T 按比例退还", async () => {
    const svc = setup([acct(11)], [card(1, 11)]);
    await push(svc, "card-1", { input: 10, q: quota(11, 100, 100) }); // 建窗满
    await push(svc, "card-1", { input: 1000, q: quota(11, 30, 100) }); // 降到 30 → delta 归 card-1
    const Tlow = fair(svc, 11).attributed["card-1"] ?? 0;
    expect(Tlow).toBeGreaterThan(0);
    // 账号回血 80,持续确认(≥5min ≥2次)
    await push(svc, "card-1", { input: 0, q: quota(11, 80, 100) }); // pending #1
    now += 6 * 60 * 1000;
    await push(svc, "card-1", { input: 0, q: quota(11, 80, 100) }); // #2,>5min → 采纳
    const st = fair(svc, 11);
    expect(st.lastFraction).toBeCloseTo(0.8, 5); // 采纳回血
    expect(st.attributed["card-1"] ?? 0).toBeLessThan(Tlow); // T 被退还(血条恢复)
  });

  // ── 先增后减 ───────────────────────────────────────────────────────────────
  it("先增后减:回血采纳后再降 → 降立即跟随", async () => {
    const svc = setup([acct(11)], [card(1, 11)]);
    await push(svc, "card-1", { input: 10, q: quota(11, 50, 50) });
    // 持续回升到 90
    await push(svc, "card-1", { input: 0, q: quota(11, 90, 90) });
    now += 6 * 60 * 1000;
    await push(svc, "card-1", { input: 0, q: quota(11, 90, 90) });
    expect(fair(svc, 11).lastFraction).toBeCloseTo(0.9, 5);
    // 再降立即
    await push(svc, "card-1", { input: 10, q: quota(11, 60, 90) });
    expect(fair(svc, 11).lastFraction).toBeCloseTo(0.6, 5);
  });

  // ── 抖动 vs 不抖动 ─────────────────────────────────────────────────────────
  it("抖动·跨账号交错:真50 与 探自别号的98 交错 → 假值被拒,低水位稳在真值不抖", async () => {
    const svc = setup([acct(11), acct(22)], [card(1, 11)]);
    await push(svc, "card-1", { input: 10, q: quota(11, 50, 50) });
    await push(svc, "card-1", { input: 0, q: quota(22, 98, 100) }); // 探自 22 → 拒
    await push(svc, "card-1", { input: 0, q: quota(11, 50, 50) });
    await push(svc, "card-1", { input: 0, q: quota(22, 98, 100) }); // 拒
    expect(fair(svc, 11).lastFraction).toBeCloseTo(0.5, 5); // 一直稳在真值,不抖
  });

  it("不抖动·平滑单调下降 0.9→0.7→0.5 → 低水位平滑跟随", async () => {
    const svc = setup([acct(11)], [card(1, 11)]);
    const r = new Date(now + 4 * HOUR).toISOString();
    for (const f of [90, 70, 50]) await push(svc, "card-1", { input: 100, q: quota(11, f, 90, r) });
    expect(fair(svc, 11).lastFraction).toBeCloseTo(0.5, 5);
  });

  // ── 幂等:重复上报同一份 quota → 不重复扣 ────────────────────────────────
  it("幂等:同一 fraction 连报两次 → 第二次 delta=0,不重复归因", async () => {
    const svc = setup([acct(11)], [card(1, 11)]);
    await push(svc, "card-1", { input: 10, q: quota(11, 100, 100) });
    await push(svc, "card-1", { input: 1000, q: quota(11, 50, 100) });
    const T1 = fair(svc, 11).attributed["card-1"] ?? 0;
    await push(svc, "card-1", { input: 0, q: quota(11, 50, 100) }); // 同值再报
    const T2 = fair(svc, 11).attributed["card-1"] ?? 0;
    expect(T2).toBeCloseTo(T1, 6); // 不重复扣
  });

  // ── 自计时翻窗:离线跨 5h 窗口 → 自动 reset(primed=false),首值采纳不凭空扣 ──
  it("自计时翻窗:离线跨 5h 无上报 → 下次上报自动 reset,首个真值采纳、不凭空扣在场卡", async () => {
    const svc = setup([acct(11)], [card(1, 11)]);
    await push(svc, "card-1", { input: 1000, q: quota(11, 100, 100) }); // 建窗满
    now += 5 * HOUR + 60 * 1000; // 跨过 5h 窗口
    await push(svc, "card-1", { input: 10, q: quota(11, 90, 100) }); // 首个真值
    const st = fair(svc, 11);
    expect(st.lastFraction).toBeCloseTo(0.9, 5);   // 采纳 90(不是把 1.0−0.9 凭空扣)
    expect(st.attributed["card-1"] ?? 0).toBe(0);  // 新窗口 T 归零,无凭空消耗
  });
});
