# 第三方 Claude 母号接入:技术方案(v0.2)

状态:草案。适用范围:公司内部几个人共用若干 Claude 母号,通过 gfa 的"一键托管"使用,按 token 和模型计费。

## 1. 目标与非目标

目标
- 同事点"一键托管"后无感使用 Claude,看不到母号的 key。
- 每次调用按 `模型 × token 类型` 计费,记录到每个同事名下。
- 第三方只提供母号(`base_url + key + 剩余额度`),号池调度、计费、对账都在 gfa。

非目标
- 不改动现有 Codex / Antigravity / 白号租号流程。
- 不做对外售卖级的充值、发票、风控。

## 2. 模式

第三方每个母号等同于一个 DeepSeek 式的 API 入口:一个 `base_url`、一个 `key`、一个可查询的剩余额度。gfa 持有这些 key,代同事转发请求。

- key 不下发给客户端。客户端只拿 gfa 的个人 token,`ANTHROPIC_BASE_URL` 指向 gfa。
- token 数由 gfa 从响应 usage 中统计,不依赖客户端上报。
- 第三方的 `/usage` 明细只用于对账,不参与计费。

## 3. 总体架构

```
同事桌面端(Claude Code)
   │  ANTHROPIC_BASE_URL = gfa,Authorization = 个人 session token
   ▼
gfa  /v1/messages(新增转发入口)
   │ 1 鉴权:解析个人身份(沿用 SessionTokenResolver)
   │ 2 预检:同事余额、并发上限
   │ 3 选号:从母号池挑一个可用号
   │ 4 转发:用该号的 base_url + key 调用,带 X-Request-Id
   ▼
第三方母号入口  /v1/messages
   │ 返回流式响应(含 usage)
   ▼
gfa:解析 usage → 计费入账 → 透传响应

后台任务:拉母号列表、刷新剩余额度、拉 /usage 对账
```

> 待确认:我只读了号池和租号控制器,没有确认 gfa 是否已有"服务端代转发 Anthropic 请求"的路径。落地前先在 `apps/server/src/leasing/lease-core/lease-service.ts` 中核实,没有则新建。

## 4. 数据模型

新增三张表(Prisma):

| 表 | 关键字段 | 说明 |
|---|---|---|
| `GatewayAccount` | `id, externalId(唯一), email, baseUrl, keyEncrypted, plan, status, balanceValue, balanceUnit, balanceRefreshedAt, inflight, cooldownUntil` | 第三方母号镜像。`keyEncrypted` 用服务端密钥加密存储,日志中脱敏 |
| `ModelPrice` | `model, inputPer1M, outputPer1M, cacheReadPer1M, cacheWrite5mPer1M, cacheWrite1hPer1M, markup` | 向同事收费的价格表 |
| `GatewayUsage` | `requestId(唯一), userId, accountId, model, 各类 token, costUsd, upstreamStatus, createdAt` | 每次调用的用量与成本,`requestId` 唯一保证幂等 |

## 5. 选号与调度

1. 候选集:`status = active`、`cooldownUntil` 已过、剩余额度高于阈值、`inflight` 未达该号并发上限、该号 `models` 包含请求的模型。
2. 排序:优先同一用户上次用的号(提高 prompt cache 命中),其次剩余额度多的、`inflight` 少的。
3. 失败处理:
   - 429:按 `Retry-After` 设置 `cooldownUntil`,换号重试一次。
   - 额度耗尽(402 或第三方约定的状态码):标记该号 `exhausted`,换号重试一次。
   - 401/403:标记 `invalid`,告警,换号重试一次。
   - 5xx 或网络错误:不扣费,换号重试一次。
   - 重试仍失败,向客户端返回 503 并附 `Retry-After`。
4. 流式请求一旦开始向客户端输出,就不再换号。

## 6. 计费规则

```
cost = input×Pin + output×Pout + cache_read×Pcr + cache_write_5m×Pw5 + cache_write_1h×Pw1h
cost_charged = cost × markup
```

- 单价均为每百万 token,取自 `ModelPrice`,以响应里的实际模型名为准,不用请求里的别名。
- 流式请求中途断开:按已收到的 usage 计;拿不到 usage 时,先记 `pending`,待对账结果补记。
- 失败请求(上游 5xx、被封、额度耗尽)不扣费。
- 我们向同事收的价格和第三方扣的额度是两套口径,不要求相等,只用于对账时比对趋势。

## 7. 额度刷新与对账

- 额度刷新:每 5 分钟拉一次母号列表(或按 key 查额度),更新 `balanceValue`。每次请求结束后本地估减,下次刷新时校正。后台提供"手动刷新"按钮,见 7.1 节。
- 对账分两档:
  - 有第三方 `/usage` 且支持 `request_id`:每小时拉明细,按 `requestId` 与 `GatewayUsage` 逐条比对,发现漏记补记,差异写告警。目标差异率低于 1%。
  - 无 `request_id`:按母号和时间窗口汇总 token 总量对比,差异超过阈值(默认 5%)告警。
- 额度单位若是百分比,无法反推单次成本,只能做趋势对账。需要在合同或联调时确认单位。

## 7.1 定期刷新与窗口重置

定时任务(默认每 5 分钟,可配置)拉 `GET /accounts`。后台另提供手动刷新接口 `POST /console/gateway/accounts/refresh`(见 8.1 节的权限要求),与定时任务共用同一段逻辑和同一把互斥锁,10 秒内重复触发直接返回上次结果,避免打爆第三方。对每个母号:

1. 更新状态、`models`、`balance`、`windows`。新母号入库,消失的母号标记 `disabled`,不删除。
2. 判断重置。满足任一条件即视为该号某个窗口已重置:
   - `window_id` 与上次不同(首选,最可靠)。
   - 第三方没给 `window_id` 时,`remaining_percent` 比上次高出 `RESET_JUMP`(默认 20 个百分点),且 `balance` 没有同步增加。
   不要用 `== 100` 判断:窗口重置前用过一点,恢复值可能不是 100。
3. 充值和重置要区分:`balance.remaining` 上升而 `window_id` 不变,视为充值,只更新余额,不清用户额度。
4. 触发重置时,在一个事务里:
   - 把该母号上所有同事的"本窗口已用额度"清零,新窗口起点记为当前时间。
   - 写一条 `GatewayWindowReset` 记录(母号、窗口名、旧值、新值、触发依据、时间),供审计和排障。
   - 解除因额度耗尽造成的 `exhausted` 状态,让该号重新进入调度。
5. 刷新有延迟:从重置实际发生到 gfa 发现最多晚 5 分钟(手动刷新可立即发现)。这段时间内同事仍按旧窗口计费,发现后不回溯修正。
6. 防抖:同一窗口 5 分钟内最多处理一次重置,避免第三方数据抖动造成重复清零。

> 待你确认:"所有用户的额度"指什么。如果是每人在该号上的份额(gfa 现有的 FairShare 窗口就是这类机制),重置应清零份额用量;如果是每人的美元余额,则不应随母号窗口重置而清零,否则同事可以靠窗口重置免费刷新。

## 8. 可靠性与安全

- 母号 key 加密存储,密钥放服务端环境变量;日志、错误信息、管理后台均脱敏。
- 转发时剥离客户端自带的 `Authorization`,换成母号 key;只透传 `anthropic-version`、`anthropic-beta` 等白名单头。
- 每个同事设并发上限(默认 3)和日预算,超限返回 429。
- 请求体和响应体不落库,只存 usage 和元数据。
- 第三方不可用时,返回 503 并附 `Retry-After`。
- 同事邮箱等个人信息不发送给第三方,转发请求里只带 `X-Request-Id`。

## 8.1 母号 key 保密方案

母号 key 是整个系统最值钱的东西。按"假设有一层会被攻破"来设计,逐层限制损失。

**存储**
- 入库前用 AES-256-GCM 加密,每条记录独立随机 nonce。加密主密钥(KEK)不放数据库,也不放代码仓库,放在环境变量或云厂商 KMS / 密钥管家里。
- 数据库、备份、dump 里只有密文。备份文件单独加密,不要把主密钥和备份放在同一台机器。
- 明文 key 只在转发那一刻解密进内存,不缓存到 Redis、日志或磁盘,用完即丢。
- 现有 `dev.db`、`prisma/*.db` 等本地库不得导入真实 key,开发环境用第三方测试号。

**读取路径只开一条**
- 只有"转发服务"这一个模块能解密 key。后台接口、日志、错误信息、监控、导出功能全部只返回脱敏值(如 `sk-****a1b2`)。
- 后台没有"查看 key 明文"的功能。运维需要换 key 时,走"覆盖写入",不走"读出再改"。
- 日志中间件对 `Authorization`、`x-api-key`、`key` 字段统一脱敏,上线前用测试 key 在日志里全文搜一遍。

**管理接口(手动刷新、母号看板)**
- 沿用 `console/*` 的全局 JWT 守卫,不加 `@Public()`,参照 [rosetta.controller.ts](apps/server/src/leasing/rosetta/rosetta.controller.ts) 的做法。
- 另加角色限制:只有超级管理员可触发刷新和改配置,其余角色只读脱敏列表。
- 手动刷新限频(每人每分钟 3 次),每次调用写审计日志:谁、何时、来源 IP、结果。
- 管理后台只对公司内网或 VPN 开放,在网关或 Caddy 层加 IP 白名单,公网不可达。

**网络与出口**
- gfa 到第三方只走 HTTPS。第三方侧给 gfa 的管理密钥加 IP 白名单,只允许 gfa 服务器出口 IP。能做到的话再上 mTLS。
- 转发入口 `/v1/messages` 不返回任何与母号有关的信息:响应头里去掉第三方的 `X-Account-Id` 等标识,错误信息统一改写成 gfa 自己的文案。
- 同事客户端永远拿不到 `baseUrl` 和 key,只拿 gfa 的个人 token。个人 token 设有效期,支持吊销。

**发现与止损**
- 每个母号单独设日用量上限和异常告警:单号单小时用量超过近 7 天同时段均值的 3 倍,或出现非 gfa 出口 IP 的调用(需要第三方在 `/usage` 里返回来源 IP),立即告警。
- 准备好"一键换 key"流程:第三方侧吊销旧 key,gfa 用手动刷新拉新 key。每季度演练一次,同时也要定期轮换。
- 离职或权限变更时,立即吊销该人的 gfa token 和后台角色。
- 部署机器遵循最小权限:不开放无关端口,SSH 只用密钥登录,服务账号不使用 root。

**残余风险**
即使以上都做到,服务器本身被完全攻破时,攻击者可在内存里拿到解密后的 key。因此要限制 key 的价值:第三方侧按号限额,出现异常时靠告警和换 key 把损失压到最小。

## 9. 上线步骤

1. 与第三方对齐 `third-party-claude-gateway-api.md`,拿到测试母号。
2. 实现母号同步、选号、转发,用测试母号跑通流式与非流式。
3. 实现计费与幂等,用第三方 `/usage` 做 1 天灰度对账。
4. 管理后台加母号看板和告警(额度低、号失效、对账差异)。
5. 2~3 名同事灰度一周,再全员开放。

## 10. 待决事项

| 事项 | 选项 | 建议 |
|---|---|---|
| 余额体系 | 复用现有订阅额度 / 新增美元余额 | 内部使用,新增 `balanceUsd` 更直观 |
| 预扣方式 | 请求前预扣 / 事后扣 | 事后扣加余额下限检查,实现简单 |
| 加价 `markup` | 1.0 / 大于 1 | 内部分摊用 1.0 |
| 额度单位 | 美元 / token / 百分比 | 要求第三方给美元或 token |
| 第三方是否支持 `request_id` | 支持 / 不支持 | 不支持则退为汇总对账 |

## 11. 风险

- 多人共用同一订阅母号可能违反 Anthropic 服务条款,存在封号风险。母号少、并发集中时更容易触发风控。
- 第三方是单点。需要明确封号后的补号时限和换 key 的通知方式。
- gfa 持有所有母号 key,gfa 服务端一旦被入侵,key 会整体泄露。加密存储和访问审计必须做。
