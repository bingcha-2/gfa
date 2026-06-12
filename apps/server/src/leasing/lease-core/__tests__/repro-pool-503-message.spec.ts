import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LeaseService } from "../lease-service";
import type { Provider } from "../provider";
import { sessionReqFor, withSessionResolver } from "../../token-server/__tests__/session-test-util";

// ════════════════════════════════════════════════════════════════════════════
// 整池都租不到时的文案:若主因是 503 容量冷却(cooling)→ 明说【官方上游抽风】,
// 不是用户额度问题(别再笼统"额度恢复中")。antigravity 单独加重语气骂谷歌。
// ════════════════════════════════════════════════════════════════════════════

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeProvider(id: string, accountsFilePath: string): Provider<any> {
  return {
    id,
    accountsFilePath,
    refreshToken: vi.fn(async () => "access-token-ok"),
    normalizeAccount: (raw: any) => ({
      ...raw,
      id: Number(raw.id),
      email: String(raw.email || ""),
      refreshToken: String(raw.refreshToken || ""),
      enabled: raw.enabled !== false,
    }),
    isAccountEligible: () => true,
    applyQuotaSnapshot: (account: any) => ({ account, creditDelta: null }),
    egressPolicy: "optional" as const,
    leaseResponseExtras: () => ({}),
  } as unknown as Provider<any>;
}

const REQ = sessionReqFor("card-1");
const MODEL = "gemini-2.5-pro";

let tempDir: string;
let accountsFilePath: string;
let accessKeysFilePath: string;
let clock: number;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "repro-pool503-"));
  accountsFilePath = path.join(tempDir, "accounts.json");
  accessKeysFilePath = path.join(tempDir, "access-keys.json");
  clock = 1_000_000;
  writeJson(accessKeysFilePath, {
    keys: [{ id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000, windowLimit: 1e9 }],
  });
  writeJson(accountsFilePath, {
    accounts: [{ id: 1, email: "a@x.com", refreshToken: "rt-1", enabled: true }],
  });
});
afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function makeService(id: string) {
  return withSessionResolver(new LeaseService(makeProvider(id, accountsFilePath), {
    accessKeysFilePath,
    minClientVersion: "",
    now: () => clock,
  }));
}

// 把全池打成 503 容量冷却(cooling),再租一次拿到整池不可用文案。
async function leaseThenCool503(svc: LeaseService<any>): Promise<string> {
  const l: any = await svc.leaseToken(REQ, { clientId: "c1", modelKey: MODEL });
  await svc.reportResult(REQ, { leaseId: l.leaseId, status: 503, reason: "http_503_service_unavailable", modelKey: MODEL });
  try {
    await svc.leaseToken(REQ, { clientId: "c1", modelKey: MODEL });
    throw new Error("应当因整池冷却而失败");
  } catch (e: any) {
    return String(e?.message || e);
  }
}

describe("整池 503 不可用文案", () => {
  it("antigravity:整池 503 冷却 → 明说 antigravity 抽风、sb谷歌,不是额度问题", async () => {
    const msg = await leaseThenCool503(makeService("antigravity"));
    expect(msg).toContain("谷歌");
    expect(msg).toContain("antigravity");
    expect(msg).toContain("503");
    expect(msg).not.toContain("额度恢复中");
    console.log(`[文案] antigravity 503 → ${msg}`);
  });

  it("其它产品:整池 503 冷却 → 官方上游暂不稳定(命名产品+模型)", async () => {
    const msg = await leaseThenCool503(makeService("codex"));
    expect(msg).toMatch(/官方上游暂不稳定|503/);
    expect(msg).toContain("Codex");
    expect(msg).not.toContain("额度恢复中");
    console.log(`[文案] codex 503 → ${msg}`);
  });

  it("429 额度耗尽(不是 503) → 不骂谷歌,回原'无可用号'文案", async () => {
    const svc = makeService("antigravity");
    const l: any = await svc.leaseToken(REQ, { clientId: "c1", modelKey: MODEL });
    // 429 → exhausted(配额),不是 cooling
    await svc.reportResult(REQ, { leaseId: l.leaseId, status: 429, reason: "http_429_resource_exhausted", modelKey: MODEL });
    const msg = await svc.leaseToken(REQ, { clientId: "c1", modelKey: MODEL }).then(() => "").catch((e) => String(e?.message || e));
    expect(msg).not.toContain("谷歌"); // 额度问题不该甩锅谷歌
    console.log(`[文案] antigravity 429 → ${msg}`);
  });

  it("503 是别的 model 的冷却 → 当前 model 不该骂谷歌(按 modelKey 精确判定)", async () => {
    const svc = makeService("antigravity");
    const lA: any = await svc.leaseToken(REQ, { clientId: "c1", modelKey: "gemini-2.5-flash" });
    // 只冷却 flash(503)
    await svc.reportResult(REQ, { leaseId: lA.leaseId, status: 503, reason: "http_503_service_unavailable", modelKey: "gemini-2.5-flash" });
    // 当前请求是 pro:该号对 pro 仍可用 → 能租到(根本不会走到不可用文案)
    const r: any = await svc.leaseToken(REQ, { clientId: "c1", modelKey: "gemini-2.5-pro" });
    expect(r.ok).toBe(true);
    console.log(`[精确] flash 的 503 不影响 pro:pro 仍租到 acct=${r.accountId}`);
  });
});
