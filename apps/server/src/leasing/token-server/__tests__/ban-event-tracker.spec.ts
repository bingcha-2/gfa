import { describe, expect, it, vi } from "vitest";

import { BanEventTracker } from "../ban-event-tracker";

function makePrisma() {
  return { accountBanEvent: { create: vi.fn().mockResolvedValue({}) } };
}

describe("BanEventTracker — 内存环形缓冲", () => {
  it("每个母号只保留最近 N 条,溢出淘汰最旧", () => {
    const t = new BanEventTracker(makePrisma(), { ringSize: 3 });
    for (let i = 0; i < 5; i++) {
      t.observeRequest({ provider: "anthropic", accountId: 1, status: 200, modelKey: `m${i}` });
    }
    expect(t.ringSizeFor("anthropic", 1)).toBe(3);
    expect(t.ringSnapshotFor("anthropic", 1).map((r) => r.modelKey)).toEqual(["m2", "m3", "m4"]);
  });

  it("环按 provider+accountId 隔离", () => {
    const t = new BanEventTracker(makePrisma());
    t.observeRequest({ provider: "anthropic", accountId: 1, status: 200 });
    t.observeRequest({ provider: "codex", accountId: 1, status: 200 });
    expect(t.ringSizeFor("anthropic", 1)).toBe(1);
    expect(t.ringSizeFor("codex", 1)).toBe(1);
  });

  it("缺 provider/accountId 的请求被忽略", () => {
    const t = new BanEventTracker(makePrisma());
    t.observeRequest({ provider: "", accountId: 1, status: 200 } as any);
    t.observeRequest({ provider: "anthropic", accountId: 0, status: 200 });
    expect(t.ringSizeFor("anthropic", 1)).toBe(0);
  });
});

describe("BanEventTracker — recordBan 落库", () => {
  it("创建封号事件,把环按顺序 dump 成请求时间线,然后清空该环", async () => {
    const prisma = makePrisma();
    const t = new BanEventTracker(prisma, { now: () => 1000 });
    t.observeRequest({ provider: "anthropic", accountId: 7, accessKeyId: "card-a", status: 200, totalTokens: 10, reverseProxy: true });
    t.observeRequest({ provider: "anthropic", accountId: 7, accessKeyId: "card-b", status: 200, totalTokens: 20 });

    await t.recordBan({
      provider: "anthropic", accountId: 7, accountEmail: "x@y.com",
      reason: "banned", upstreamStatus: 403, upstreamBody: "account disabled", modelKey: "claude", deathStrikes: 3,
    });

    expect(prisma.accountBanEvent.create).toHaveBeenCalledTimes(1);
    const arg = (prisma.accountBanEvent.create as any).mock.calls[0][0];
    expect(arg.data).toMatchObject({
      provider: "anthropic", accountId: 7, accountEmail: "x@y.com",
      reason: "banned", upstreamStatus: 403, modelKey: "claude", deathStrikes: 3,
    });
    const reqs = arg.data.requests.create;
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toMatchObject({ seq: 0, accessKeyId: "card-a", reverseProxy: true, totalTokens: 10 });
    expect(reqs[1]).toMatchObject({ seq: 1, accessKeyId: "card-b", reverseProxy: false, totalTokens: 20 });
    expect(t.ringSizeFor("anthropic", 7)).toBe(0); // 清空
  });

  it("空环也照样建事件(requests 为空)", async () => {
    const prisma = makePrisma();
    const t = new BanEventTracker(prisma);
    await t.recordBan({ provider: "codex", accountId: 99, reason: "invalid_grant" });
    const arg = (prisma.accountBanEvent.create as any).mock.calls[0][0];
    expect(arg.data.requests.create).toEqual([]);
  });

  it("超长 upstreamBody 截断", async () => {
    const prisma = makePrisma();
    const t = new BanEventTracker(prisma);
    await t.recordBan({ provider: "codex", accountId: 1, upstreamBody: "x".repeat(5000) });
    const arg = (prisma.accountBanEvent.create as any).mock.calls[0][0];
    expect(arg.data.upstreamBody.length).toBeLessThanOrEqual(1000);
  });

  it("prisma 失败时绝不抛(遥测不可影响主流程)", async () => {
    const prisma = { accountBanEvent: { create: vi.fn().mockRejectedValue(new Error("db down")) } };
    const t = new BanEventTracker(prisma);
    await expect(t.recordBan({ provider: "codex", accountId: 1 })).resolves.toBeUndefined();
  });

  it("封禁证据也过滤 STATE，明文含凭据时不存原文", async () => {
    const prisma = makePrisma();
    const t = new BanEventTracker(prisma);
    await t.recordBan({ provider: "codex", accountId: 1,
      reason: "account_deactivated", upstreamBody: JSON.stringify({ error: { code: "account_deactivated", current_turn_state: "state-secret" }, Authorization: "Bearer token-secret" }) });
    expect(JSON.parse(prisma.accountBanEvent.create.mock.calls[0][0].data.upstreamBody)).toEqual({ error: { code: "account_deactivated" } });
    await t.recordBan({ provider: "codex", accountId: 1, upstreamBody: "upstream rejected; X-Codex-Turn-State: state-secret" });
    expect(prisma.accountBanEvent.create.mock.calls[1][0].data.upstreamBody).toBe("[redacted]");
  });
});

it.each([
  "https://example.test/?access_token=url-secret",
  "grant_type=refresh_token&refresh_token=form-secret",
  '{"sessionToken":"session-secret","code":"invalid_prompt"}',
  '{"session_token":"session-secret","code":"invalid_prompt"}',
])("redacts credentials in URL, form and session-token fields: %s", async (upstreamBody) => {
  const prisma = makePrisma();
  await new BanEventTracker(prisma).recordBan({ provider: "codex", accountId: 1, upstreamBody });
  const stored = prisma.accountBanEvent.create.mock.calls[0][0].data.upstreamBody;
  expect(stored).not.toMatch(/url-secret|form-secret|session-secret/);
  if (upstreamBody.startsWith("{")) expect(JSON.parse(stored)).toEqual({ code: "invalid_prompt" });
});