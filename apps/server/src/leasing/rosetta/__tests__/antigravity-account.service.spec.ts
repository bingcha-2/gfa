// addAccount 的「按 id 重授权」分支直测 —— 这段移植逻辑此前只被 google-oauth 测试
// 间接触达(且 addAccountChecked 被 stub),真逻辑没跑过:match-by-id、清健康标记、
// email 覆盖、目标不存在报错。这里直接驱动同步的 addAccount(不走 probe/网络)。
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AntigravityAccountService } from "../antigravity-account.service";

let dir = "";

function makeSvc() {
  // addAccount 只用 ctx.dataDir(直接 readJson/writeJson accounts.json);accessKey 不参与。
  const ctx = { dataDir: dir } as any;
  return new AntigravityAccountService(ctx, {} as any);
}

function writeAccounts(accounts: any[]) {
  fs.writeFileSync(path.join(dir, "accounts.json"), JSON.stringify({ accounts }), "utf8");
}

function readAccounts(): any[] {
  const data = JSON.parse(fs.readFileSync(path.join(dir, "accounts.json"), "utf8"));
  return data.accounts;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-antigravity-acct-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("AntigravityAccountService.addAccount — 按 id 重授权", () => {
  it("命中目标号:换新 token、清掉 cliproxy 健康标记、覆盖 email", () => {
    writeAccounts([
      {
        id: 5,
        email: "old@example.com",
        refreshToken: "old-rt",
        enabled: true,
        alias: "Old",
        projectId: "p-5",
        planType: "free",
        quotaStatus: "exhausted",
        quotaStatusReason: "quota",
        blockedUntil: 1234567890,
      },
    ]);

    const r = makeSvc().addAccount({
      targetAccountId: 5,
      email: "new@example.com",
      refreshToken: "new-rt",
    });

    expect(r).toMatchObject({ ok: true, id: 5, isUpdate: true, totalAccounts: 1 });

    const acc = readAccounts().find((a) => a.id === 5);
    expect(acc.refreshToken).toBe("new-rt");
    expect(acc.email).toBe("new@example.com"); // email 被覆盖
    // 号刚换新 token,旧的死号/限额状态必须作废,否则复活后仍被当死号跳过。
    expect(acc.quotaStatus).toBeUndefined();
    expect(acc.quotaStatusReason).toBeUndefined();
    expect(acc.blockedUntil).toBeUndefined();
  });

  it("按 id 命中而非 email:目标号 email 与 payload 不同也命中同一条,不新增", () => {
    writeAccounts([
      { id: 5, email: "old@example.com", refreshToken: "old-rt", enabled: true },
    ]);

    const r = makeSvc().addAccount({
      targetAccountId: 5,
      email: "totally-different@example.com", // 与现有 email 不同
      refreshToken: "new-rt",
    });

    expect(r).toMatchObject({ ok: true, id: 5, isUpdate: true });
    const accounts = readAccounts();
    expect(accounts).toHaveLength(1); // 没因 email 不同而新建第二条
    expect(accounts[0].email).toBe("totally-different@example.com");
  });

  it("目标号不存在:报错且不改动文件", () => {
    writeAccounts([
      { id: 5, email: "a@example.com", refreshToken: "rt", enabled: true },
    ]);
    const before = fs.readFileSync(path.join(dir, "accounts.json"), "utf8");

    const r = makeSvc().addAccount({
      targetAccountId: 999,
      email: "ghost@example.com",
      refreshToken: "rt",
    });

    expect(r).toEqual({ ok: false, error: "目标账号不存在" });
    expect(fs.readFileSync(path.join(dir, "accounts.json"), "utf8")).toBe(before); // 文件原封不动
  });

  it("无 targetAccountId 时按 email 命中老号(回归:不误伤新增路径)", () => {
    writeAccounts([
      { id: 5, email: "dup@example.com", refreshToken: "old-rt", enabled: true },
    ]);

    const r = makeSvc().addAccount({
      email: "dup@example.com", // 同 email,无 targetAccountId → 走 email 命中更新
      refreshToken: "new-rt",
    });

    expect(r).toMatchObject({ ok: true, id: 5, isUpdate: true });
    expect(readAccounts()).toHaveLength(1);
    expect(readAccounts()[0].refreshToken).toBe("new-rt");
  });
});
