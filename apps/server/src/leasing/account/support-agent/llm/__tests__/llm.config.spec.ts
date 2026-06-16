/**
 * llm.config.spec.ts — 客服 LLM 配置解析
 *
 * 覆盖:
 *   1. 配齐 + 开关开 → enabled
 *   2. 开关关 → 禁用(即便配齐)
 *   3. 缺 key/baseUrl/model 任一 → 禁用(即便开关开)
 *   4. maxToolIters:默认 6 / 合法值 / 非法回退
 *   5. 开关多种真值写法
 */
import { describe, it, expect } from "vitest";

import { loadSupportLlmConfig } from "../llm.config";

const full: Record<string, string | undefined> = {
  SUPPORT_LLM_BASE_URL: "https://api.deepseek.com",
  SUPPORT_LLM_API_KEY: "sk-test",
  SUPPORT_LLM_MODEL: "deepseek-chat",
  SUPPORT_AGENT_ENABLED: "true",
};

describe("loadSupportLlmConfig", () => {
  it("配齐 + 开关开 → enabled", () => {
    const c = loadSupportLlmConfig(full);
    expect(c.enabled).toBe(true);
    expect(c.baseUrl).toBe("https://api.deepseek.com");
    expect(c.model).toBe("deepseek-chat");
    expect(c.maxToolIters).toBe(6);
  });

  it("开关关 → 禁用", () => {
    expect(loadSupportLlmConfig({ ...full, SUPPORT_AGENT_ENABLED: "false" }).enabled).toBe(false);
    expect(loadSupportLlmConfig({ ...full, SUPPORT_AGENT_ENABLED: undefined }).enabled).toBe(false);
  });

  it("缺任一要素 → 禁用", () => {
    expect(loadSupportLlmConfig({ ...full, SUPPORT_LLM_API_KEY: "" }).enabled).toBe(false);
    expect(loadSupportLlmConfig({ ...full, SUPPORT_LLM_BASE_URL: "" }).enabled).toBe(false);
    expect(loadSupportLlmConfig({ ...full, SUPPORT_LLM_MODEL: "" }).enabled).toBe(false);
  });

  it("maxToolIters:合法取值 / 非法回退 6", () => {
    expect(loadSupportLlmConfig({ ...full, SUPPORT_LLM_MAX_TOOL_ITERS: "3" }).maxToolIters).toBe(3);
    expect(loadSupportLlmConfig({ ...full, SUPPORT_LLM_MAX_TOOL_ITERS: "0" }).maxToolIters).toBe(6);
    expect(loadSupportLlmConfig({ ...full, SUPPORT_LLM_MAX_TOOL_ITERS: "abc" }).maxToolIters).toBe(6);
  });

  it("开关接受多种真值写法", () => {
    for (const v of ["1", "true", "YES", "On"]) {
      expect(loadSupportLlmConfig({ ...full, SUPPORT_AGENT_ENABLED: v }).enabled).toBe(true);
    }
  });
});
