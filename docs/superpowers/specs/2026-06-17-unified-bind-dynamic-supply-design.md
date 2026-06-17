# 统一绑定线动态供给设计

日期：2026-06-17

范围：客户订阅、套餐目录、后台容量控制、租约调度、额度展示、老卡迁移。

## 背景

当前系统对客户暴露两条线：

- 号池线：通过 `bucketLimits` / `weeklyTokenLimit` 给静态卡额度，不占账号座位，运行时从动态池租号。
- 绑定线：通过产品会员等级、`bindings`、`weight` 占用账号份额，并把运行时租约钉到绑定账号。

这会带来两个产品问题：

- 号池线利用率更高，因为上游账号里别人没用完的额度可以被其他客户吸收，但客户心智不像“绑定拼车”。
- 绑定线客户心智清晰，但当前实现把绑定账号当作唯一可用账号。只要该账号没额度，即使客户订阅自己的额度还没用完，也会被阻塞。

目标方向是砍掉客户可见的“号池线”，统一成“绑定线套餐”，同时在后台保留动态供给和超卖能力。

## 目标

- 客户按产品和席位购买稳定额度权益。
- 客户只看到产品类型、席位、价格和血条式额度，不看到后台账号分配、超卖数量或换号过程。
- 后台可以按配置对账号进行席位制超卖。
- 首绑账号优先使用，但首绑账号没额度或不健康时，运行时可以自动换其它账号。
- 客户端展示必须让客户感觉额度稳定准确：自己的额度只因自己使用而下降。
- 客户端展示的账号额度对应最新租约实际账号，避免“账号没额度但还能继续用”的矛盾。
- 老卡迁移不能改变客户已经购买的实际额度。

## 非目标

- 不向客户暴露超卖、账号剩余席位或运行时 fallback。
- 不把学习额度的实时波动直接展示给客户。
- 不在迁移老卡时重置已有用量窗口。
- 不继续保留 `poolEnabled` 作为产品概念。账号是否供给只看 `enabled` 和运行时健康状态。

## 产品模型

客户侧统一为绑定线购买体验：

- 产品/类型：Claude、Codex、Antigravity，或支持的组合。
- 席位：`1`、`2`、`4`、`8`。
- 一个席位等于 `1/8`。`1` 表示 `1/8`，`2` 表示 `2/8`，`8` 表示 `8/8`。
- 客户购买时不展示实际分配到哪个上游账号。

后台把一次购买理解为：

- 一份固定客户额度权益。
- 每个产品一个首选/展示账号。
- 一套运行时动态供给策略。

## 额度基准

新订阅在购买或后台授予时直接保存具体额度。

默认基准：

- Claude：读取学习出的 `anthropic:max-20x:claude` 预算，再乘以 `shareSeats / 8`。
- Codex：读取学习出的 `codex:pro:gpt` 预算，再乘以 `shareSeats / 8`。
- Antigravity Gemini：固定 Ultra 基准，5h `100M`，周 `400M`，再乘以 `shareSeats / 8`。
- Antigravity Claude/Opus：固定 Ultra 基准，5h `12M`，周 `40M`，再乘以 `shareSeats / 8`。

学习系统只作为后台生成新套餐额度的建议来源。它不能让已生效客户的展示额度上下浮动。客户购买后，订阅保存的是当时算出的 token 上限，在该订阅周期内保持稳定。

Antigravity 使用固定基准，因为当前 Ultra 学习数据不够可靠，不适合直接作为客户可见额度来源。

## 订阅 Config

新统一绑定线订阅建议使用下面的结构：

```json
{
  "line": "bind",
  "products": ["anthropic"],
  "levels": {
    "anthropic": "max-20x"
  },
  "shareSeats": 2,
  "shareCapacity": 8,
  "bucketLimits": {
    "anthropic-claude": 20000000
  },
  "weeklyBucketLimits": {
    "anthropic-claude": 100000000
  },
  "displayBindings": {
    "anthropic": 12
  },
  "assignmentPolicy": "preferred-dynamic",
  "deviceLimit": 1,
  "windowMs": 18000000
}
```

字段语义：

- `products`：客户开通的产品权益。
- `levels`：购买时使用的额度基准，也是运行时“同等级优先”的排序依据。
- `shareSeats`：客户购买的席位数，一个席位等于 `1/8`。
- `shareCapacity`：份额分母，默认 `8`，用于展示和额度折算。
- `bucketLimits`：客户自己的 5h 固定额度，按复合桶存储。
- `weeklyBucketLimits`：客户自己的周固定额度，按复合桶存储。
- `displayBindings`：每个产品的首绑/展示账号，也是运行时首选账号。
- `assignmentPolicy: "preferred-dynamic"`：首绑优先，但允许动态换号。

`bindings` 在迁移期保留为 legacy 镜像，但当 `assignmentPolicy` 是 `preferred-dynamic` 时，新逻辑不能再把它理解为“必须钉死到这个账号”。

`weeklyTokenLimit` 只保留旧卡和旧路径兼容。新套餐购买和后台授予统一使用 `weeklyBucketLimits`。

## 后台容量规则

`poolEnabled` 退役。以后所有 `enabled=true` 的账号都天然进入动态供给池。旧数据里的 `poolEnabled=false` 在迁移后忽略。如果运营要把某个账号移出供给，只设置 `enabled=false`。

后台需要一个统一配置入口，按产品/基准配置：

- 产品。
- 基准等级，例如 Claude `max-20x`、Codex `pro`、Antigravity `ultra`。
- 额度来源：`learned` 或 `fixed`。
- 固定 5h 和周额度。
- 每账号可售席位数。
- 客户可选席位：固定为 `1`、`2`、`4`、`8`。
- 动态供给默认开启。

可售席位按 `1/8` 单位统计：

- 配置值 `10` 表示该账号最多可作为首绑/展示账号卖出 10 个 `1/8` 席位。
- `2/8` 订阅消耗 `2` 席。
- `8/8` 订阅消耗 `8` 席。

购买或后台授予时，被选为首绑展示账号必须满足：

- `enabled !== false`。
- 满足产品基础条件，例如有 token，Antigravity 有 project id。
- 剩余可售席位大于等于本次购买的 `shareSeats`。
- 尽量选择当前额度健康的账号。

销售席位统计只看 ACTIVE 订阅的 `displayBindings`。运行时兜底不受“销售席位已满”限制，只看账号当前健康和额度。

## 购买与后台授予流程

客户购买流程：

1. 客户选择产品/类型和 `1`、`2`、`4`、`8` 席。
2. 服务端计算具体 `bucketLimits` 和 `weeklyBucketLimits`。
3. 服务端为每个产品选择首绑/展示账号。
4. 首绑选择先看购买基准等级，同等级不够时可跨等级。
5. 账号剩余可售席位必须 `>= shareSeats`。
6. 多个候选满足时，优先选择额度更健康、风险更低的账号。
7. 写入订阅 config，并按需要同步 legacy 镜像字段。

如果付款前没有任何账号能作为某产品的首绑展示账号，应阻止购买，而不是创建一个未分配的订阅。后台手动授予也应走同样预检；只有明确的强制/人工路径可以绕过，并由运营承担风险。

## 租约调度

每次 lease 请求按下面顺序执行：

1. 解析订阅，确认订阅覆盖当前请求产品。
2. 检查客户级 `bucketLimits`，确认当前请求 bucket 未超 5h 额度。
3. 检查客户级 `weeklyBucketLimits`，确认当前请求 bucket 未超周额度。
4. 读取 `displayBindings[product]` 作为首选账号。
5. 如果首选账号 enabled、可用、健康，并且当前请求 bucket 有额度，就使用首选账号。
6. 如果首选账号不可用，就搜索同产品同等级账号。
7. 如果同等级账号都不可用，就搜索同产品所有 enabled 账号，不限制等级。
8. 候选账号按当前请求 bucket 的剩余额度排序。
9. 没有任何账号能服务时，返回供给不足或可重试错误。

候选排序：

```text
score = min(remaining5hFraction, remainingWeeklyFraction)
```

只按当前请求 bucket 排序。例如 Claude 请求看 `anthropic-claude`，Codex 请求看 `codex-gpt`，Antigravity 请求看对应的 `antigravity-*` bucket。

如果账号级周窗口没有可靠数据，就只按 5h 排序。不要为了排序伪造账号级周数据。客户自己的周额度仍由 `weeklyBucketLimits` 强制拦截。

允许跨等级兜底。等级只影响优先级，不是运行时硬限制，因为客户权益已经在订阅里固化。

## 服务端响应语义

响应应尽量兼容旧客户端，但动态绑定订阅的语义要调整：

- runtime account 是本次实际服务账号。
- preferred/display account 不一定等于 runtime account。
- 客户端遇到运行时失败应允许重新租约和换号。

建议响应结构：

```json
{
  "bound": false,
  "displayBound": true,
  "accountId": 205,
  "emailHint": "cu***@example.com",
  "planType": "pro",
  "serviceAccount": {
    "accountId": 205,
    "emailHint": "cu***@example.com",
    "planType": "pro"
  },
  "accessKeyStatus": {
    "quotaMode": "static",
    "products": ["codex"],
    "buckets": [],
    "weeklyBuckets": []
  },
  "accountBuckets": {}
}
```

对于 `preferred-dynamic`，`bound` 不能再表示“没有其它账号可换”。现有客户端会用 `bound=true` 禁用轮换，所以动态绑定响应不应把这个字段设成旧含义的 `true`。

## 客户端展示

桌面客户端展示两组血条：

```text
Claude · 2/8 席

我的席位
5h  [血条]
周   [血条]

当前服务账号
5h  [血条]
周   [有数据时显示血条]
```

展示规则：

- 主血条不显示具体 token 数。
- “我的席位”只使用订阅固定额度和本卡用量。
- “我的席位”必须稳定。其他客户使用、学习值变化、首绑账号没额度、运行时换号，都不能影响它。
- “当前服务账号”显示最新 lease 实际使用的账号。
- 如果运行时 fallback 换了账号，当前服务账号信息和账号血条一起变化。
- 原“绑定账号信息”面板改名为“当前服务账号”或同义文案。
- 不向客户提示该账号是否 fallback，也不展示换号过程。
- 不把首绑账号包装成永远不变的承诺。

这里刻意不使用“虚拟账号血条”。虚拟血条能隐藏换号，但会制造另一个矛盾：真实账号没额度时，客户仍能通过其它账号继续使用。展示当前 lease 的真实账号，可以避免这个矛盾。

客户仍然通过稳定的席位标签和固定额度感知到这是绑定线产品：

```text
Claude · 2/8 席
```

客户端还必须修复状态同步：

- Codex-only 和 Claude-only 路径必须把 `accessKeyStatus` 同步到统一本地状态。
- 即使主 Antigravity leaser 不运行，静态卡额度也必须正常展示。
- `accountFractions` / `accountBuckets` 是当前服务账号数据，不是客户权益数据。

## 客户门户

Web 客户门户与客户端口径一致：

- 展示产品和席位。
- 额度血条来自 `bucketLimits` 和 `weeklyBucketLimits`。
- 不展示后台超卖和 fallback 分配。
- 不把真实 account id 展示成客户权益。
- 历史订阅可以展示“历史套餐”和约等于的席位标签。

## 老卡迁移

老卡权益必须保留。迁移不能按新基准重算老卡额度。

号池/静态老卡：

- 保留原有 `bucketLimits`。
- 只有当旧周额度能等价映射且不改变权益时，才填充 `weeklyBucketLimits`。
- 保留旧 `weeklyTokenLimit` 用于兼容。
- 可行时迁移为统一绑定语义，并设置 `assignmentPolicy: "preferred-dynamic"`。
- 在席位容量允许时，为已开通产品分配首绑/展示账号。

绑定老卡：

- 原绑定账号保留为 `displayBindings`。
- 保留原额度和用量窗口。
- 符合条件的卡切换为 preferred-dynamic 运行时行为。

老卡展示席位标签：

- 按真实 5h 额度换算，忽略 `1` 这类占位封禁值。
- `<= 8M` 展示为 `1` 席。
- `> 8M && <= 16M` 展示为 `2` 席。
- `> 16M && <= 32M` 展示为 `4` 席。
- `> 32M` 展示为 `8` 席。

多产品老卡保留各产品原额度，展示为历史套餐，不假装它完全等于新的目录 SKU。

## 重点影响代码

预计影响模块：

- `apps/server/src/leasing/plan-catalog/pricing.ts`
- `apps/server/src/leasing/subscription/subscription-config.ts`
- `apps/server/src/leasing/subscription/entitlement-sync.service.ts`
- `apps/server/src/leasing/subscription/seat.ts`
- `apps/server/src/leasing/lease-core/lease-service.ts`
- `apps/server/src/leasing/lease-core/subscription-scheduler.ts`
- `apps/server/src/leasing/token-server/access-key-store.ts`
- `apps/server/src/leasing/token-server/token-billing.ts`
- `apps/server/src/leasing/account/portal/portal.service.ts`
- `apps/server/src/leasing/account/card-migration/card-migration.service.ts`
- `apps/web/src/components/account/catalog-purchase.tsx`
- `apps/web/src/app/(console)/console/(dashboard)/(product)/plan-catalog/*`
- `apps/web/src/app/(console)/console/(dashboard)/(customer)/*`
- `apps/app/frontend/src/pages/DashboardPage.tsx`
- `apps/app/frontend/src/components/BoundAccountsCard.tsx`
- `apps/app/leaser.go`
- `apps/app/codex_leaser.go`
- `apps/app/claude_leaser.go`
- `apps/app/leaser_status.go`

## 错误处理

客户卡级额度耗尽：

- 返回客户额度耗尽错误。
- reset 信息来自本卡 5h 或周窗口。

首绑账号耗尽：

- 不作为客户额度问题暴露。
- 继续尝试动态 fallback。

所有供给账号都不可用：

- 返回供给不足或可重试账号容量错误。
- 客户端文案应表达为服务恢复中，而不是“你的卡没额度”。

账号鉴权或永久异常：

- 按现有运行时健康逻辑标记账号不健康。
- 动态绑定订阅应先尝试其它账号，再把问题暴露给客户。

账号周数据缺失：

- 不伪造周数据参与排序。
- 继续强制客户级 `weeklyBucketLimits`。

## 迁移与上线顺序

建议上线步骤：

1. 支持 `weeklyBucketLimits` 的校验和 public status。
2. 支持解析 `shareSeats`、`shareCapacity`、`displayBindings`、`assignmentPolicy`。
3. 新增后台容量配置和销售席位统计。
4. 修改目录购买/后台授予，生成带固定额度的统一绑定 config。
5. 修改 lease 调度为 preferred-dynamic。
6. 客户端改为“我的席位”和“当前服务账号”展示。
7. 迁移老卡和历史订阅。
8. 移除 `poolEnabled` UI 和运行时过滤。

上线期间旧订阅必须继续可用；新订阅使用新 config 结构。迁移确认完成后，再移除旧号池线购买入口。

## 测试计划

服务端测试：

- 购买 `1`、`2`、`4`、`8` 席时正确生成 `bucketLimits` 和 `weeklyBucketLimits`。
- Antigravity 固定基准生成预期 5h 和周额度。
- Claude/Codex 学习基准在购买时被固化，之后学习值变化不影响已有订阅。
- 没有账号剩余可售席位 `>= shareSeats` 时阻止购买。
- 销售席位统计只统计 ACTIVE 订阅的 `displayBindings`。
- 运行时优先尝试首绑账号。
- 首绑账号没额度时 fallback 到同等级账号。
- 同等级不可用时跨等级 fallback。
- 候选排序在 5h 和周都已知时使用 `min(5h, weekly)`。
- `weeklyBucketLimits` 能按 bucket 强制拦截周额度。
- `weeklyTokenLimit` 兼容旧记录。
- `poolEnabled=false` 不再排除 otherwise enabled 的账号。

客户端测试：

- “我的席位”血条从本卡 5h/周 bucket 渲染，并且主展示不显示具体 token 数。
- 最新租约账号变化时，“当前服务账号”信息和账号血条一起更新。
- Codex-only 和 Claude-only 订阅能同步统一 `accessKeyStatus`。
- 旧“绑定账号信息”文案被移除或改名。
- 页脚不把容易误解的真实账号 id 展示成客户权益。

迁移测试：

- 老静态卡保留原 `bucketLimits`。
- 老周额度不丢失。
- 老卡席位标签按 8M 阈值映射。
- 现有用量窗口保留。
- 老绑定卡保留原账号作为首绑/展示账号。

## 已确认决策

- 允许跨等级 fallback。
- 客户可购买席位只有 `1`、`2`、`4`、`8`。
- 超卖配置单位是席位，不是“车”。
- `poolEnabled` 退役，`enabled` 才是账号是否参与供给的权威字段。
- 客户端展示当前 lease 的真实服务账号，不展示虚拟账号，也不强行展示第一个首绑账号。
