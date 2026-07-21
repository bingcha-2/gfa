/**
 * Codex 客户端可选模型的内置目录。
 *
 * 中转模式默认按原模型名直通，不对客户端选择的模型做隐式降级。
 * 上游未提供某个模型时，应由上游明确返回不支持。
 */
export const CODEX_MODEL_DISPLAY_NAMES: Record<string, string> = {
  "gpt-5-codex": "GPT-5 Codex",
  "gpt-5-codex-mini": "GPT-5 Codex Mini",
  "gpt-5.1-codex-max": "GPT-5.1 Codex Max",
  "gpt-5.1-codex-mini": "GPT-5.1 Codex Mini",
  "gpt-5.2": "GPT-5.2",
  "gpt-5.2-codex": "GPT-5.2 Codex",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.3-codex-spark": "GPT-5.3 Codex Spark",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.6-terra": "GPT-5.6 Terra",
};

export const DEFAULT_CODEX_RELAY_MODELS = Object.freeze(
  Object.keys(CODEX_MODEL_DISPLAY_NAMES),
);

export const DEFAULT_CODEX_RELAY_MODEL_MAP: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(DEFAULT_CODEX_RELAY_MODELS.map((model) => [model, model])),
);
