# 第三方 Claude 母号接口文档(gfa 对接草案 v0.2)

本文档是 gfa 向第三方提出的接口要求。每个母号对 gfa 而言等同于一个 DeepSeek 式的 API 入口:`base_url + key + 剩余额度`。第三方按此实现,双方据此联调。

标注:**必须** 为上线前提;**建议** 没有也能上线,但对账精度会下降。

## 通用约定

- 协议:HTTPS。管理类接口的 Base URL 记为 `{ADMIN}`,由第三方提供。
- 管理接口鉴权:`Authorization: Bearer <ADMIN_KEY>`,由第三方分配给 gfa。
- 时间:ISO 8601 UTC。金额:美元,精度到 1e-6。
- 错误体:`{"error":{"type":"<code>","message":"<text>"}}`。

### 母号入口的错误语义(必须)

| HTTP | type | 含义 | gfa 处理 |
|---|---|---|---|
| 401/403 | `invalid_api_key` | key 无效或母号被封 | 标记该号失效,换号重试 |
| 402 | `quota_exhausted` | 该号额度用尽 | 标记耗尽,换号重试 |
| 429 | `rate_limited` | 限流或订阅窗口用尽,带 `Retry-After`(秒) | 设冷却,换号重试 |
| 5xx | `upstream_error` | 上游错误 | 不计费,换号重试 |

如果第三方使用其他状态码,请在联调前书面说明。

## 1. 母号列表(必须)

### `GET {ADMIN}/accounts`

查询参数:`status`(可选,`active|cooldown|banned|disabled`)、`page`、`page_size`(默认 50)。

响应:

```json
{
  "data": [
    {
      "id": "acc_001",
      "email": "a***@example.com",
      "plan": "max_20x",
      "status": "active",
      "status_reason": null,
      "base_url": "https://api.vendor.example/acc_001",
      "key": "sk-xxxxxxxx",
      "models": ["claude-sonnet-4-5-20250929", "claude-opus-4-1-20250805"],
      "balance": { "unit": "usd", "remaining": 82.35, "total": 200.0 },
      "windows": [
        { "name": "five_hour", "remaining_percent": 57.5, "resets_at": "2026-11-01T08:00:00Z", "window_id": "5h-20261101-03" },
        { "name": "weekly", "remaining_percent": 82.0, "resets_at": "2026-11-05T00:00:00Z", "window_id": "wk-202644" }
      ],
      "limits": { "concurrency": 5, "rpm": 60 },
      "updated_at": "2026-11-01T06:30:00Z"
    }
  ],
  "page": 1,
  "page_size": 50,
  "total": 4
}
```

字段说明:
- `base_url` + `key`:调用该号的入口,见第 2 节。**key 只出现在这个接口里,请只对 gfa 的管理密钥开放。**
- `models`:该号当前可调用的模型 id 列表(必须)。gfa 按它过滤候选号,模型变化时以最新一次拉取为准。
- `balance.unit`:必须为 `usd` 或 `token`。**总额度不接受百分比**,否则无法反推单次成本。
- `windows`:订阅制母号的周期额度(5 小时、每周),允许用百分比。`resets_at` 是下次重置时间,`window_id` 每个窗口唯一、重置后必须变化,gfa 用它判断"窗口已重置"。充值只改 `balance`,不改 `window_id`。
- 如果母号没有周期窗口(纯预付费),`windows` 可省略。
- `status`:`active` 可用;`cooldown` 冷却中;`banned` 被封;`disabled` 人工停用。
- `status_reason`:非 `active` 时给出原因,如 `quota_exhausted`、`oauth_revoked`。
- `limits.concurrency`:该号建议的并发上限,gfa 据此限流。
- 号换 key 时,`id` 保持不变,`key` 更新。

### `GET {ADMIN}/accounts/{id}`(建议)

返回单个母号,字段同上。用于只刷新某一个号的额度,避免全量拉取。

### `GET {ADMIN}/models`(必须)

返回第三方支持的全部模型,供 gfa 维护价格表和对外展示:

```json
{ "data": [ { "id": "claude-sonnet-4-5-20250929", "display_name": "Claude Sonnet 4.5", "context_window": 200000, "deprecated": false } ] }
```

新增或下线模型时请提前通知,gfa 的 `ModelPrice` 需要同步更新。价格表中没有的模型,gfa 会拒绝转发,避免漏计费。

## 2. 调用入口(必须)

### `POST {base_url}/v1/messages`

与 Anthropic Messages API 保持兼容,请求体和响应体格式一致,支持 `stream: true`(SSE)。鉴权方式与 Anthropic 一致:`x-api-key: <key>`,或 `Authorization: Bearer <key>`(请说明采用哪种)。

请求头(除 Anthropic 标准头外):

| 头 | 必填 | 说明 |
|---|---|---|
| `X-Request-Id` | 建议 | gfa 生成的唯一 id。第三方在 `/usage` 明细里原样记录,用于逐条对账 |

响应体要求:`usage` 必须包含以下字段(非流式在顶层;流式在 `message_start` 和 `message_delta` 事件中,与 Anthropic 一致):

```json
{
  "model": "claude-sonnet-4-5-20250929",
  "usage": {
    "input_tokens": 1200,
    "output_tokens": 350,
    "cache_read_input_tokens": 8000,
    "cache_creation_input_tokens": 500,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 500,
      "ephemeral_1h_input_tokens": 0
    }
  }
}
```

要求说明:
- `model` 必须是实际计费的模型名,不能是别名。
- 缓存写入要拆分 5 分钟和 1 小时,两者单价不同。缺少拆分时 gfa 按 5 分钟价计,会有偏差。
- 同一个 `base_url` 还应支持 `GET /v1/models` 和 `POST /v1/messages/count_tokens`(建议)。

## 3. 按号查询额度(必须二选一)

gfa 需要在两次列表拉取之间更新剩余额度,请至少提供下面一种:

- 方式 A:`GET {ADMIN}/accounts/{id}`(见 1 节),响应延迟不超过 1 分钟。gfa 默认每 5 分钟拉一次,运维也可能手动触发,请按不低于 10 次/分钟的频率设限流。
- 方式 B:`GET {base_url}/v1/balance`,用该号的 key 鉴权,响应:

```json
{ "unit": "usd", "remaining": 82.35, "total": 200.0, "updated_at": "2026-11-01T06:30:00Z" }
```

额度的刷新延迟请书面说明。延迟越大,gfa 需要留的安全余量越大。

## 4. 用量明细(建议)

### `GET {ADMIN}/usage`

用于对账,不参与计费。

查询参数:

| 参数 | 说明 |
|---|---|
| `from`、`to` | 必填,时间范围,最大跨度 7 天 |
| `account_id` | 可选,按母号过滤 |
| `cursor`、`limit` | 分页,`limit` 默认 500,最大 1000 |

响应:

```json
{
  "data": [
    {
      "request_id": "req_9f2c...",
      "account_id": "acc_001",
      "model": "claude-sonnet-4-5-20250929",
      "status": "success",
      "input_tokens": 1200,
      "output_tokens": 350,
      "cache_read_input_tokens": 8000,
      "cache_creation_5m_input_tokens": 500,
      "cache_creation_1h_input_tokens": 0,
      "cost": 0.0213,
      "created_at": "2026-11-01T06:29:58Z"
    }
  ],
  "next_cursor": "eyJ..."
}
```

要求:
- `request_id` 为 gfa 传入的 `X-Request-Id`。如果第三方不支持自定义请求 id,请在 `request_id` 里返回第三方自己的 id,并在响应头回传同一个值,gfa 记录后做关联。
- `status`:`success`、`error`、`aborted`(客户端中断)。`error` 不扣额度;`aborted` 按已产生 token 计。
- `cost` 为第三方实际从额度中扣的金额,用于核对 gfa 估算的成本。
- 数据延迟不超过 1 分钟,至少保留 30 天。

没有 `/usage` 时,gfa 退为"按母号和时间窗口汇总 token"做对账,精度较低。

## 4.1 安全要求(必须)

母号 key 极其敏感,请第三方配合以下几点:

- 管理密钥 `ADMIN_KEY` 绑定 gfa 服务器的出口 IP 白名单,其他来源一律拒绝。能支持 mTLS 的话优先使用。
- `ADMIN_KEY` 支持轮换:可同时存在新旧两把密钥,过渡期内都有效,gfa 切换后第三方吊销旧的。
- 每个母号的 key 可单独吊销和重发,吊销后 1 分钟内生效,`id` 保持不变。
- 提供 key 的调用来源 IP 记录:`/usage` 明细中增加 `client_ip` 字段,gfa 据此发现非自己出口的调用。
- 对 `{ADMIN}/accounts` 的每次访问记录审计日志(时间、来源 IP),出现白名单外的访问尝试时通知 gfa。
- 单个 key 支持第三方侧的日额度上限,gfa 可通过管理接口设置,作为被盗用时的止损手段。

## 5. 非功能要求

| 项 | 要求 |
|---|---|
| 可用性 | ≥ 99.5%(月) |
| 母号入口额外延迟 | P95 ≤ 300ms |
| 管理接口限流 | 对 gfa 不低于 10 请求/秒 |
| 封号处理 | 母号被封后 24 小时内补号,并在 `/accounts` 中反映;换 key 时 `id` 不变 |
| 日志 | 第三方不得留存请求和响应正文,只存 usage 元数据 |

## 6. 联调检查清单

- [ ] `/accounts` 返回 `base_url`、`key`、美元或 token 单位的额度。
- [ ] 非流式 `/v1/messages` 返回完整 usage,含缓存 5 分钟和 1 小时拆分。
- [ ] 流式请求 usage 与非流式一致。
- [ ] 额度耗尽返回 402,限流返回 429 且带 `Retry-After`,被封返回 401 或 403。
- [ ] 额度查询延迟已书面确认。
- [ ] `/usage` 的 `request_id` 与 gfa 传入的 `X-Request-Id` 一一对应(或已约定关联方式)。
- [ ] 流式中途断开后,`/usage` 中有 `aborted` 记录。
- [ ] 换 key 后 `id` 保持不变。
