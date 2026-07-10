# Codex 内置 Provider 接管设计

## 目标

接管时保留 Codex 内置 `openai` provider，通过顶层 `openai_base_url` 把模型目录和生成请求统一路由到 BingchaAI 本机代理，使上游新增模型自动出现在选择器中，并消除自定义 provider 导致的模型刷新禁用与历史分桶。

## 根因

当前接管写入的 `bingchaai` provider 同时设置 `requires_openai_auth = false`，且没有 command auth。Codex 的模型管理器只在 provider 使用 Codex 后端认证或具备 command auth 时刷新远端目录，因此不会请求代理的 `/v1/models`，而是继续展示内置目录。

## 方案

- 接管写入 `model_provider = "openai"` 和 `openai_base_url = "http://127.0.0.1:<port>/v1"`，不再创建 `[model_providers.bingchaai]`。
- 首次接管备份原 `model_provider` 与 `openai_base_url`；还原时逐项恢复，保留用户原有自定义 provider 和地址。
- 兼容旧接管状态：注入和还原都会移除遗留的 `[model_providers.bingchaai]`。
- 对 `GET /v1/responses` WebSocket Upgrade 返回 `426 Upgrade Required`，触发 Codex 官方的会话级 HTTP fallback；随后 `POST /v1/responses` 继续走现有租号代理。
- 接管和还原都把旧 `bingchaai` 历史元数据归一到 `openai`，完成一次性迁移；新会话始终使用 `openai`，不再产生分桶。

## 错误与兼容

- `IsCodexInjected` 以 `model_provider=openai` 且 `openai_base_url` 等于当前本机代理地址为准。
- 旧备份缺少 `prevOpenAIBaseURL` 时按“原先未配置”处理，还原时删除本机 `openai_base_url`。
- 模型目录继续使用已实现的上游透传、请求合并和 `models_cache.json` 兜底。

## 测试

- 接管配置只写内置 provider 和 `openai_base_url`，不含 `bingchaai` provider 表。
- 原 provider、原 `openai_base_url` 均能完整 round-trip。
- 旧 `bingchaai` provider 表在注入和还原后被清理。
- WebSocket Upgrade 返回 426，普通 POST 不受影响。
- 代理与完整 Go 测试通过。
