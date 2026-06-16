/**
 * 客服 LLM 配置 —— 全部走 OpenAI 兼容接口,换供应商只改 env(DeepSeek/千问/豆包)。
 *
 *   SUPPORT_LLM_BASE_URL    如 https://api.deepseek.com
 *   SUPPORT_LLM_API_KEY
 *   SUPPORT_LLM_MODEL       如 deepseek-chat / qwen-plus / 豆包接入点ID
 *   SUPPORT_LLM_MAX_TOOL_ITERS  工具循环上限(默认 6)
 *   SUPPORT_AGENT_ENABLED   总开关;未开启或未配齐 key 时整功能关闭、前端隐藏气泡
 */
export interface SupportLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxToolIters: number;
  enabled: boolean;
}

function truthy(v: string | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function loadSupportLlmConfig(
  env: Record<string, string | undefined> = process.env,
): SupportLlmConfig {
  const baseUrl = (env.SUPPORT_LLM_BASE_URL ?? "").trim();
  const apiKey = (env.SUPPORT_LLM_API_KEY ?? "").trim();
  const model = (env.SUPPORT_LLM_MODEL ?? "").trim();

  const parsedIters = Number.parseInt(env.SUPPORT_LLM_MAX_TOOL_ITERS ?? "", 10);
  const maxToolIters =
    Number.isFinite(parsedIters) && parsedIters > 0 ? parsedIters : 6;

  // 配齐三要素 + 显式开关打开,才算启用。
  const configured = Boolean(baseUrl && apiKey && model);
  const enabled = truthy(env.SUPPORT_AGENT_ENABLED) && configured;

  return { baseUrl, apiKey, model, maxToolIters, enabled };
}

/** 客服防刷限流:按客户的发送次数上限(每分钟 / 每天)。 */
export interface SupportRateLimits {
  perMinute: number;
  perDay: number;
}

export function loadSupportRateLimits(
  env: Record<string, string | undefined> = process.env,
): SupportRateLimits {
  return {
    perMinute: posInt(env.SUPPORT_MAX_MSGS_PER_MIN, 10),
    perDay: posInt(env.SUPPORT_MAX_MSGS_PER_DAY, 50),
  };
}

function posInt(v: string | undefined, dflt: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * 知识检索的向量(embedding)配置 —— P3 语义检索用,独立于对话模型。
 * 因 DeepSeek 无 embedding,可单独指向千问/豆包/OpenAI;未配齐则不启用,
 * 检索自动回退到关键词。
 *
 *   SUPPORT_EMBED_BASE_URL / SUPPORT_EMBED_API_KEY / SUPPORT_EMBED_MODEL
 */
export interface SupportEmbedConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
}

export function loadSupportEmbedConfig(
  env: Record<string, string | undefined> = process.env,
): SupportEmbedConfig {
  const baseUrl = (env.SUPPORT_EMBED_BASE_URL ?? "").trim();
  const apiKey = (env.SUPPORT_EMBED_API_KEY ?? "").trim();
  const model = (env.SUPPORT_EMBED_MODEL ?? "").trim();
  return { baseUrl, apiKey, model, enabled: Boolean(baseUrl && apiKey && model) };
}
