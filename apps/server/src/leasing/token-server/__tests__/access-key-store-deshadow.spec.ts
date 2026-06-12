import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { AccessKeyStore } from "../access-key-store";

function makeStore(keys: any[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aks-deshadow-"));
  const p = path.join(dir, "access-keys.json");
  fs.writeFileSync(p, JSON.stringify({ keys, updatedAt: "" }));
  return new AccessKeyStore(p);
}

describe("AccessKeyStore.loadSubscriptionRecords (去影子:DB 订阅注册内存,不写文件)", () => {
  it("注册新订阅配置 record → findById 可取", () => {
    const store = makeStore([]);

    store.loadSubscriptionRecords([
      {
        id: "sub-1",
        status: "active",
        products: ["anthropic"],
        bucketLimits: { "anthropic-claude": 50000 },
        weeklyTokenLimit: 250000,
        windowMs: 18000000,
      } as any,
    ]);

    expect(store.findById("sub-1")).toMatchObject({
      id: "sub-1",
      status: "active",
      bucketLimits: { "anthropic-claude": 50000 },
    });
  });

  it("已存在同 id(有用量)→ 刷新配置、保留用量窗口(配置变更不清零限额)", () => {
    const store = makeStore([
      {
        id: "sub-1",
        status: "active",
        bucketLimits: { "anthropic-claude": 10000 },
        tokenUsageEvents: [{ at: 1, tokens: 5 }],
      },
    ]);

    store.loadSubscriptionRecords([
      {
        id: "sub-1",
        status: "active",
        bucketLimits: { "anthropic-claude": 99999 },
        windowMs: 18000000,
      } as any,
    ]);

    const rec = store.findById("sub-1") as any;
    expect(rec.bucketLimits).toEqual({ "anthropic-claude": 99999 }); // 配置刷新
    expect(rec.tokenUsageEvents).toEqual([{ at: 1, tokens: 5 }]); // 用量保留
  });
});
