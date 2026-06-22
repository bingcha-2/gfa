import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClaudeSessionPoolService } from "../claude-session-pool.service";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readPool(dataDir: string) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "claude-session-pool.json"), "utf8"));
}

function acc(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    email: `w${id}@example.com`,
    sessionKey: `sk-${id}`,
    proxyUrl: `socks5://u:p@h${id}:1080`,
    enabled: true,
    status: "usable",
    useCount: 0,
    ...extra,
  };
}

describe("白号池粘性绑定:一个账户固定用一个白号", () => {
  let dataDir: string;
  let svc: ClaudeSessionPoolService;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-session-pool-"));
    writeJson(path.join(dataDir, "claude-session-pool.json"), { accounts: [acc(1), acc(2)] });
    svc = new ClaudeSessionPoolService({ dataDir } as any);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("同一 cardId 连续租约始终拿到同一个白号", () => {
    const first = svc.leaseSession({ cardId: "card-A" }) as any;
    const second = svc.leaseSession({ cardId: "card-A" }) as any;
    expect(first.ok).toBe(true);
    expect(second.accountId).toBe(first.accountId);
    expect(readPool(dataDir).bindings["card-A"]).toBe(first.accountId);
  });

  it("不同 cardId 均摊到不同白号", () => {
    const a = svc.leaseSession({ cardId: "card-A" }) as any;
    const b = svc.leaseSession({ cardId: "card-B" }) as any;
    expect(a.accountId).not.toBe(b.accountId); // 第二个用户落到尚无绑定用户的号
  });

  it("绑定的白号失效后改绑到别的可用号", () => {
    const a = svc.leaseSession({ cardId: "card-A" }) as any;
    // 把它绑定的号标记为 unusable(模拟号被烧)。
    const pool = readPool(dataDir);
    pool.accounts.find((x: any) => x.id === a.accountId).status = "unusable";
    writeJson(path.join(dataDir, "claude-session-pool.json"), pool);

    const again = svc.leaseSession({ cardId: "card-A" }) as any;
    expect(again.ok).toBe(true);
    expect(again.accountId).not.toBe(a.accountId); // 改绑
    expect(readPool(dataDir).bindings["card-A"]).toBe(again.accountId);
  });

  it("无 cardId 时退回使用人数分配,不写绑定", () => {
    const r = svc.leaseSession({}) as any;
    expect(r.ok).toBe(true);
    expect(readPool(dataDir).bindings).toEqual({});
  });

  it("池子全不可用时返回错误", () => {
    writeJson(path.join(dataDir, "claude-session-pool.json"), {
      accounts: [acc(1, { status: "unusable" }), acc(2, { enabled: false })],
    });
    const r = svc.leaseSession({ cardId: "card-A" }) as any;
    expect(r.ok).toBe(false);
  });
});
