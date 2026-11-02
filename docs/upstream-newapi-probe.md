# 上游接口实测记录(new-api / sub2api 渠道)

测试日期:2026-11-01。测试地址 `https://www.tk4me.com`,key 为 newapi_channel_conn 提供的 `sk-` 开头密钥(本文不记录明文)。

## 模型列表

```
GET {BASE}/v1/models
Authorization: Bearer <key>
anthropic-version: 2023-06-01
```

- HTTP 200,返回 `{"data":[{id, object, created, owned_by, supported_endpoint_types}]}`,共 68 个模型,其中 Claude 14 个。
- 同时混有 grok、gemini、gpt 等模型,需要按 `id` 前缀 `claude-` 过滤。
- 没有 `context_window`、价格等字段,价格表需要我们自己维护。
- Claude 模型:claude-opus-4-8、claude-fable-5、claude-opus-4-6、claude-sonnet-5、claude-sonnet-5-5、claude-sonnet-4-5-20250929、claude-opus-5、claude-opus-4-1-20250805、claude-haiku-4-5-20251001、claude-opus-5-5、claude-fable-5-1、claude-sonnet-4-6、claude-opus-4-7、claude-haiku-5-5。

## 调用

```
POST {BASE}/v1/messages
Authorization: Bearer <key>      (x-api-key: <key> 同样返回 200)
anthropic-version: 2023-06-01
content-type: application/json
```

- 请求体与 Anthropic Messages API 一致,支持 `stream: true`。
- 非流式响应的 `usage` 完整:`input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`、`cache_creation.ephemeral_5m_input_tokens`、`cache_creation.ephemeral_1h_input_tokens`。
- 流式响应的事件序列为 `message_start`、`content_block_*`、`ping`、`message_delta`、`message_stop`,`usage` 在 `message_start` 和 `message_delta` 里。

## 待核实的异常

- 同一个 "hi" 请求,非流式 `input_tokens` 为 8,流式 `message_delta` 里却是 4111,`message_start` 里是 1。两者差距很大,不能直接信任流式 usage 计费。需要和上游确认,或者多做几次对比。
- 响应头 `X-New-Api-Version`、`X-Oneapi-Request-Id` 表明这是 new-api 网关,不是 Anthropic 官方入口。
- 此地址未与 `pool.tk4me.com` 的私有 key 验证过是否同一个入口。

---

## pool.tk4me.com 实测(2026-11-01,用运营 key 测试,不是开出的私有 key)

- `GET https://pool.tk4me.com/v1/models`:200。`Authorization: Bearer` 和 `x-api-key` 两种鉴权都可用。
- 返回 Anthropic 官方格式 `{"data":[{"type":"model","id","display_name"}],"has_more":false}`,共 14 个,全是 Claude 模型,不混入其他厂商,不需要按前缀过滤。没有价格和上下文长度。
- 模型:claude-opus-4-6、claude-sonnet-4-5-20250929、claude-haiku-4-5-20251001、claude-fable-5-1、claude-fable-5、claude-opus-5-5、claude-opus-5、claude-opus-4-8、claude-opus-4-7、claude-opus-4-1-20250805、claude-sonnet-5-5、claude-sonnet-5、claude-sonnet-4-6、claude-haiku-5-5。
- `POST https://pool.tk4me.com/v1/messages`:非流式(x-api-key)和流式(Bearer)都是 200。
- 同一个 "say ok" 请求,非流式 usage 为输入 9 / 输出 4,流式 `message_start` 为输入 9 / 输出 1(占位),`message_delta` 为输入 9 / 输出 4,三处一致。www.tk4me.com 上出现的 4106、4111 偏高现象在 pool 上本次未复现,但只测了 1 组。
- 流式的 `message_start` 里 `output_tokens` 只是占位值,以 `message_delta` 为准。
