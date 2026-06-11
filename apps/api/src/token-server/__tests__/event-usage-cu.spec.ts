import { describe, expect, it } from "vitest";

import { eventUsageForLimit, eventWeightedCost } from "../token-billing";

// 静态封顶口径(批次 B1):anthropic / codex 桶按 CU(加权);antigravity(含 gemini 与
// antigravity-claude)维持原始计费。CU 各家族自归一:claude 以 Opus 输入为内部基准
// (opus 1/5/0.1、haiku 0.2/1/0.02),gpt 单档 1/8/0.1。
describe("CU 计量:eventWeightedCost / eventUsageForLimit", () => {
  const ev = (over: Record<string, unknown> = {}) => ({
    inputTokens: 100, outputTokens: 50, cachedInputTokens: 0,
    rawTotalTokens: 150, totalTokens: 150,
    product: "anthropic", modelKey: "claude-opus-4", ...over,
  });

  it("anthropic opus → CU 加权 100×1 + 50×5 = 350", () => {
    expect(eventUsageForLimit(ev())).toBe(350);
  });

  it("anthropic haiku → CU 100×0.2 + 50×1 = 70", () => {
    expect(eventUsageForLimit(ev({ modelKey: "claude-haiku-4-5" }))).toBe(70);
  });

  it("codex gpt → CU 100×1 + 50×8 = 500", () => {
    expect(eventUsageForLimit(ev({ product: "codex", modelKey: "gpt-5-codex" }))).toBe(500);
  });

  it("antigravity(gemini)→ 原始计费(不加权)= 150", () => {
    expect(eventUsageForLimit(ev({ product: "antigravity", modelKey: "gemini-2.5-pro" }))).toBe(150);
  });

  it("antigravity-claude → 仍原始(本轮只改 anthropic/codex 产品)= 150", () => {
    expect(eventUsageForLimit(ev({ product: "antigravity", modelKey: "claude-sonnet-4-6" }))).toBe(150);
  });

  it("无 input/output 拆分(total-only)→ 退回原始,不臆测方向", () => {
    expect(eventWeightedCost({ totalTokens: 300, rawTotalTokens: 300, modelKey: "gpt-5-codex" })).toBe(300);
    expect(eventUsageForLimit({ product: "codex", modelKey: "gpt-5-codex", totalTokens: 300, rawTotalTokens: 300 })).toBe(300);
  });

  it("缓存折算:gross input 含 cached,netInput 去掉(opus 100in/80cache/10out → 78)", () => {
    // netInput = 100-80 = 20 → 20×1 + 10×5 + 80×0.1 = 78
    expect(eventWeightedCost({
      product: "anthropic", modelKey: "claude-opus-4",
      inputTokens: 100, outputTokens: 10, cachedInputTokens: 80,
    })).toBe(78);
  });
});
