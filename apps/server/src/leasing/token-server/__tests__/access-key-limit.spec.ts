import { describe, expect, it } from "vitest";

import {
  requestBucket,
  computeUsageDetail,
  bucketUsageSince,
  bucketUsageInWindow,
  bucketUsageInWindowReadonly,
} from "../access-key-limit";
import { eventUsageForLimit } from "../token-billing";
import { bucketKey, modelFamily } from "../../lease-core/product-bucket";

describe("access-key-limit.requestBucket", () => {
  it("有 product → 委托给 bucketKey(product, modelKey)", () => {
    expect(requestBucket("anthropic", "claude-opus-4")).toBe(bucketKey("anthropic", "claude-opus-4"));
    expect(requestBucket("codex", "gpt-5-codex")).toBe(bucketKey("codex", "gpt-5-codex"));
    expect(requestBucket("antigravity", "gemini-2.5-pro")).toBe(bucketKey("antigravity", "gemini-2.5-pro"));
  });

  it("无 product(legacy)→ 退回 modelFamily(modelKey)", () => {
    expect(requestBucket(undefined, "gemini-2.5-pro")).toBe(modelFamily("gemini-2.5-pro"));
    expect(requestBucket("", "claude-opus-4")).toBe(modelFamily("claude-opus-4"));
  });
});

describe("access-key-limit.computeUsageDetail", () => {
  it("归一出 token 计数,并按 product/model 解析计费桶", () => {
    const d = computeUsageDetail({ inputTokens: 100, outputTokens: 50 }, "gemini-2.5-pro", "antigravity");
    expect(d.bucket).toBe(requestBucket("antigravity", "gemini-2.5-pro"));
    expect(d.inputTokens).toBe(100);
    expect(d.outputTokens).toBe(50);
    expect(d.totalTokens).toBeGreaterThan(0);
  });

  it("未给 rawTotalTokens → 回退为 input + output", () => {
    const d = computeUsageDetail({ inputTokens: 10, outputTokens: 5 }, "gpt-5-codex", "codex");
    expect(d.rawTotalTokens).toBe(15);
  });

  it("空 usage → 全 0,bucket 仍按 model 解析", () => {
    const d = computeUsageDetail({}, "gpt-5-codex", "codex");
    expect(d.inputTokens).toBe(0);
    expect(d.outputTokens).toBe(0);
    expect(d.totalTokens).toBe(0);
    expect(d.bucket).toBe(requestBucket("codex", "gpt-5-codex"));
  });
});

describe("access-key-limit.bucketUsageSince", () => {
  const bucket = requestBucket("antigravity", "gemini-2.5-pro"); // gemini = 原始计量,口径确定
  const rec = (events: any[]) => ({ tokenUsageEvents: events });

  it("只累加 at>=windowStart 且 bucket 匹配的事件", () => {
    const hit = { at: 1000, product: "antigravity", modelKey: "gemini-2.5-pro", rawTotalTokens: 100, totalTokens: 100 };
    const early = { at: 500, product: "antigravity", modelKey: "gemini-2.5-pro", rawTotalTokens: 999, totalTokens: 999 }; // 早于窗口
    const other = { at: 2000, product: "codex", modelKey: "gpt-5-codex", rawTotalTokens: 888, totalTokens: 888 };          // 别的桶
    expect(bucketUsageSince(rec([hit, early, other]), bucket, 1000)).toBe(eventUsageForLimit(hit));
  });

  it("无匹配事件 / 无事件数组 → 0", () => {
    expect(bucketUsageSince(rec([]), bucket, 0)).toBe(0);
    expect(bucketUsageSince({} as any, bucket, 0)).toBe(0);
  });
});

describe("access-key-limit.bucketUsageInWindow / Readonly", () => {
  const bucket = requestBucket("antigravity", "gemini-2.5-pro");

  it("汇总当前窗口内的桶用量(pool:per-bucket 固定窗,未过期)", () => {
    const now = 10_000_000;
    const ev = { at: now - 1000, product: "antigravity", modelKey: "gemini-2.5-pro", rawTotalTokens: 200, totalTokens: 200 };
    // 5h 走 per-bucket 窗:bucketWindowStartedAt[bucket]=now-2000(年龄 2000 < windowMs 5000 未过期)
    // → 窗起点 = now-2000;事件 now-1000 在窗内。
    const record: any = { windowMs: 5_000, bucketWindowStartedAt: { [bucket]: now - 2000 }, tokenUsageEvents: [ev] };
    expect(bucketUsageInWindow(record, bucket, now, 0)).toBe(eventUsageForLimit(ev));
    expect(bucketUsageInWindowReadonly(record, bucket, now, 0)).toBe(eventUsageForLimit(ev));
  });

  it("窗口外的事件不计入", () => {
    const now = 10_000_000;
    const old = { at: now - 9000, product: "antigravity", modelKey: "gemini-2.5-pro", rawTotalTokens: 200, totalTokens: 200 };
    // 窗起点 now-2000,事件 now-9000 早于窗起点 → 不计入(readonly 不改窗起点)。
    const record: any = { windowMs: 5_000, bucketWindowStartedAt: { [bucket]: now - 2000 }, tokenUsageEvents: [old] };
    expect(bucketUsageInWindowReadonly(record, bucket, now, 0)).toBe(0);
  });
});
