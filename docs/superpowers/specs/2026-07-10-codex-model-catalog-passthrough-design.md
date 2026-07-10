# Codex 模型目录透传设计

## 背景

Codex 接管把 `model_provider` 切到 `bingchaai`，并把 provider 的 `base_url` 指向本地代理 `/v1`。因此新版 Codex 的 `GET /v1/models?client_version=...` 会进入 `CodexProxy`。

当前 `sendModels` 返回写死的 OpenAI 通用模型列表：`{"object":"list","data":[...]}`。新版 Codex 实际要求 Codex 专用目录：`{"models":[ModelInfo...]}`。这个响应既无法自动获得新模型，也与当前客户端协议不一致。

## 目标

- 接管状态下展示当前 ChatGPT/Codex 上游实际下发的模型，包括后续新增模型。
- 不在 GFA 内维护第二套长期模型缓存。
- 上游模型目录不可用时，不阻塞 Codex 启动和模型选择。
- 模型目录请求不计生成次数、不扣 Token、不触发用量上报。

## 非目标

- 不修改生成请求、WebSocket、Responses 转发或计费逻辑。
- 不修改 GFA 服务端、数据库或租号协议。
- 不人工维护 GPT-5.6 等模型清单。
- 不改写上游模型目录字段。

## 架构

`CodexProxy` 保留 `/v1/models` 的专用分支，但将静态 `sendModels` 替换为目录透传：

1. 保留客户端的 `client_version` 查询参数。
2. 通过现有 `CodexLeaser.LeaseToken` 获取号池 token；该请求不做用量上报。
3. 请求 `https://chatgpt.com/backend-api/codex/models`，注入租约的 `Authorization`、`ChatGPT-Account-Id` 和 Codex 官方客户端头。
4. 上游必须返回 2xx 且响应体必须包含 JSON `models` 数组；验证通过后原样返回响应体与 `ETag`。
5. 同一张卡、同一查询参数的并发请求通过 singleflight 风格的进程内合并共享同一个上游结果。结果完成后立即移出，不形成 TTL 缓存。
6. 上游失败时读取 `~/.codex/models_cache.json`。该文件由 Codex 自己维护，当前上游实现的 TTL 为 5 分钟。文件必须是合法 JSON 且包含 `models` 数组；验证通过后原样返回，并把文件中的 `etag` 提升为响应头。
7. 本机缓存也不可用时返回 `{"models":[]}` 和 HTTP 200，让 Codex 使用自身内置目录。

## 超时和出口

- 官方模型请求使用 4 秒上下文超时，短于 Codex 模型刷新请求约 5 秒的外层超时。
- 继续使用 Codex 的 uTLS HTTP client 和租约下发的出口策略。
- 账号绑定出口失败时沿用现有 optional egress 降级规则。
- 不把客户端传来的 `Authorization` 发给上游；它可能是本机伪登录 token。只使用租约 token。
- 强制 `Accept: application/json` 和 `Accept-Encoding: identity`，便于验证并原样返回 JSON。

## 组件边界

### `CodexProxy.ServeHTTP`

只负责识别 `GET /v1/models` 并调用模型目录处理器。其他方法继续走现有 405/非生成分流。

### 模型目录获取器

负责租号、构造官方请求、读取有限大小响应、校验目录和返回 `body + etag`。允许通过现有测试桩注入租号函数，并增加模型 HTTP client 工厂注入点，避免测试访问真实网络。

### 并发合并器

以 `card + RawQuery` 为 key。第一个请求执行获取；后续请求等待完成并复制结果。完成后删除 key，不保存结果。

### 磁盘兜底

只读取 `codexHomeDir()/models_cache.json`，不写文件。返回前校验顶层 `models` 数组。多余的 `client_version`、`fetched_at` 等字段保留，Codex 的反序列化会忽略未知字段。

## 错误处理

- 无卡、租号失败、请求构造失败、超时、传输失败、非 2xx、响应过大或 JSON 协议错误都视为官方目录失败。
- 失败只写一条不含 token/card 的诊断日志，然后尝试磁盘兜底。
- 降级响应始终为 HTTP 200；模型目录不可用不应把 Codex 主界面卡死。
- 只有经过协议校验的上游或磁盘响应才返回给 Codex。

## 测试

- `/v1/models` 保留 `client_version` 并映射到 `/backend-api/codex/models`。
- 上游收到租约 token、真实账号 ID、JSON Accept 头，不收到客户端假 token。
- GPT-5.6 风格的完整 `{"models": [...]}` 响应与 `ETag` 原样返回。
- 两个并发相同请求只执行一次租号和一次上游请求。
- 上游非 2xx、超时或畸形 JSON 时返回临时 `models_cache.json`。
- 磁盘缓存缺失/畸形时返回 `{"models":[]}`。
- 模型目录请求不调用用量上报函数。

## 验收标准

- 最新 Codex 在接管后能从官方目录看到 GPT-5.6 系列模型。
- GFA 不再包含写死的 Codex 模型 ID 列表。
- 连续模型刷新遵循 Codex 自己的 5 分钟缓存；GFA 不延长可见性刷新时间。
- `go test` 和 `go test -race` 的 Codex 代理相关测试通过。
