# 用量与限流重构:卡密维度 → 账户维度

> 状态:草案(已与需求方逐节对齐)
> 日期:2026-06-13 · 分支:account-system

## 1. 背景与现状

GFA 的用量统计与限流目前是**卡密(accessKeyId)维度**:

- 唯一用量明细表 `CardTokenUsage` 按 `accessKeyId` 记录(`prisma/schema.prisma`),写入点在 `reportResult`(`apps/server/src/leasing/lease-core/lease-service.ts:920-936` → `token-server/token-usage-tracker.ts:80` 批量 flush),事件只带 `accessKeyId`/`accountId`(上游母号),**无 `customerId`**。
- 账户(`Customer`)只是订阅容器:`Customer 1:N Subscription`,且 `Subscription.id == AccessKeyRecord.id == CardTokenUsage.accessKeyId`(三者相等,`lease-service.ts:838` 注释)。
- 限流是**三道闸**,全部按卡(=订阅)算:
  - 闸① 5h 桶限额 `bucketLimits`(`token-server/access-key-store.ts:555-587`)
  - 闸② 周限额 `weeklyTokenLimit`(`access-key-store.ts:589-626`)
  - 闸③ fair-share 公平份额,仅绑定卡(`lease-service.ts:457-464`,`token-server/fair-share-tracker.ts:279-323`)
- 权威卡存储是文件 `access-keys.json`(`AccessKeyStore`,`access-key-store.ts:181-414`);DB 订阅经 `EntitlementSyncService.loadSubscriptionRecords` 注册进内存 `subscriptionById`(现成桥头堡)。
- token 下发是**上游真实 token、客户端直连上游**(`lease-service.ts:585-630`),非反代。
- app 客户端(Wails)登录只认**单个**订阅(`apps/server/.../app/app-auth/app-auth.service.ts:47` `getActiveSubscription`),主界面 `apps/app/frontend/src/pages/DashboardPage.tsx` 围绕单订阅组织,**重度展示母号**:号余量血条(`DashboardPage.tsx:187-196`)+ `BoundAccountsCard.tsx`(母号身份:脱敏邮箱+档位+token)+ footer `accountId`。核心 UX = "号余量 vs 我的卡"双血条对照。

## 2. 目标与非目标

**目标**
1. 账户成为身份与入口,订阅成为唯一使用/计费/限流单元;**卡密形态彻底退役**。
2. **订阅优先级 + 自动接力**:用户排订阅优先级,当前订阅某产品额度用尽时,后端自动接力到下一个有额度的订阅,对用户无感。
3. `leaseToken` 账户化(JWT→customerId,后端在订阅间调度)。
4. 用量统计账户聚合,可下钻到订阅;运维"母号→账户"视图。
5. **母号血条全保留**(用户端一等公民)。
6. 存量平滑迁移(A 渐进),零中断。

**非目标**
- 不重写三道闸(各订阅各自算,逻辑不动)。
- 不改"下发上游真实 token、客户端直连上游"。
- 不做"账户级合并配额"(需求方明确否决;按订阅走)。
- 不删除 `accountId`(上游母号是物理事实,运维 + 母号血条需要)。

## 3. 终态对象模型

```
Customer(账户 = 身份/入口)
  └─1:N─ Subscription(唯一使用/计费/限流单元, 有 priority)
            │ id == 原 accessKeyId(零数据迁移)
            └─ 经 fair-share / bindings → 上游母号 accountId(物理资源, 保留)
```

卡(`AccessKeyRecord`)概念消失;`access-keys.json` 退役并入 `Subscription` 表;内部 `accessKeyId` 降级为 `subscriptionId`(值不变)。

## 4. 详细设计

### 4.1 数据模型
- `Subscription` 加 `priority Int @default(0)`(账户内接力顺序,小 = 优先)。
- `CardTokenUsage` 加 `customerId String?`(冗余,写入填 + 历史回填)+ `@@index([customerId, timestamp])`。终态重命名 `AccountTokenUsage`(过渡期先加列不改名)。
- `FairShareWindow` 不动(`[provider,accountId,bucket,cardId]`,`cardId` 语义 = `subscriptionId`)。
- `access-keys.json` → 权威迁入 `Subscription`(`AccessKeyStore` 读取点改 DB,见 4.5)。

### 4.2 leaseToken 账户化 + 订阅接力(本次核心)
- JWT 解析:`resolveFromRequest` 产出 `customerId`(不再是单 `subscriptionId`)。兼容:旧 JWT 带 subscriptionId 的,映射到其 customerId。
- 新增 `SubscriptionScheduler.pickForRequest(customerId, product, bucket, modelKey)`:
  1. 取该账户所有 ACTIVE 未过期订阅,按 `priority` 升序;
  2. 依次对每个订阅跑三道闸**预检**(复用现有 `validateRecord` + `checkFairShare`,**只读、不计数** —— `recordUsage` 只在 `reportResult` 发生,预检不污染额度);
  3. 返回第一个"该 bucket 全过"的订阅;
  4. 全不过 → `429「全部订阅额度已用完」`,附最早恢复时间 `resetMs` = 各订阅 min。
- 选中订阅后,后续(选母号 / refreshToken / createLease / 下发)沿用现有路径,`cardId` = 选中订阅 id。
- 下发体加 `activeSubscriptionId`;因接力按 bucket,客户端按产品记录"当前在用哪个订阅"。
- `reportResult` 用 `leaseId` 找回订阅(lease 已记 `accessKeyId` = 订阅 id),无歧义。

### 4.3 三道闸(不动,仅改名)
逻辑零改动;`cardId` 标识符在代码与注释里更新为 `subscriptionId`(值相等);`getCardWeight(cardId)` 等签名保留语义。

### 4.4 多订阅前端(母号保留)
**后端**
- `app-auth` 登录/心跳返回**订阅数组**(每项:id, status, expiresAt, products, priority, 各自 quota)替代单 `subscription`;兼容旧 app:同时保留 `subscription` = 优先级最高项。
- 新增 `POST /account/subscriptions/priority`(改排序)。
- `leaseToken` 回传 `activeSubscriptionId`。

**app(Wails)**
- 登录后展示**订阅列表**(`useAppStore` 存全部 + `currentSubscriptionId`);拖拽/上下移排优先级 → 调后端持久化。
- Dashboard 血条逻辑**不重构**:号余量 / 我的卡 / 绑定账号(`DashboardPage.tsx` / `BoundAccountsCard.tsx`)按 `activeSubscription` 渲染;母号三处展示全保留。
- Go 侧 `apps/app/user_auth.go` config 存订阅数组 + 当前选中;leaser 用选中订阅凭证。

**web**
- `apps/web/src/app/(account)/account/` 加"我的订阅"列表页(后端 `GET /api/account/portal/overview` 已返回数组 + quota,主要是前端);替换 `pickBestSubscription` 单选展示为列表 + 优先级。

### 4.5 卡退役与迁移(A 渐进)
- **A 渐进**:停发新卡;存量卡用户下次使用经 `apps/server/.../account/card-migration/card-migration.service.ts` 自动转订阅(ID continuity,`CardTokenUsage` / FairShare 无缝延续)。
- **AccessKeyStore 退役**:`findById` → `Subscription.findUnique`(带内存缓存);`findByKey` → `Subscription.backingKeyValue` 唯一索引;`readAll` → 分页/缓存,避免冷启全表。逐读取点切换,文件作过渡缓存,最后移除文件写。
- **B 回填**:脚本批量回填 `CardTokenUsage.customerId`(经 `accessKeyId` = subscriptionId → `Subscription.customerId`);无主(未迁移)行暂留 null,迁移后补。
- **C 收尾**:设停用日,旧卡认证通道关闭,`access-keys.json` 退役。

### 4.6 用量统计账户聚合
- 写入:`reportResult` 填 `customerId`(`record` → `subscription.customerId`,LRU 缓存避免每次 join)。
- console:用量看板按"账户 → 订阅"下钻;remote-stats 运维"母号 → 账户"(用 `CardTokenUsage.accountId` + `customerId`)。
- portal:`getUsage` 改 `where customerId`(替代 `accessKeyId in subIds` 子查询,`portal.service.ts:140`)。
- 全局接口(`token-usage-today` / `token-usage-trend`)已按 provider 汇总,不变。

## 5. 测试策略(TDD · 五层)

**TDD 节奏**:每改动先**红 → 绿 → 重构**。⚠️ 守"server 验证盲区":spec 不进 tsc、vitest 不查类型 → 每 phase 跑 CLI `tsc --noEmit` 验类型;NestJS 构造参数注入起服务冒烟。

| 层 | 本次重构具体测什么 |
|---|---|
| **单元** | `SubscriptionScheduler`(优先级排序、接力选择、全满 429、per-bucket 独立);`customerId` 写入映射 + 缓存;portal `customerId` 聚合;优先级 set/get;fair-share 改名不破坏 |
| **集成**(Nest Testing + prisma) | `leaseToken` 账户化(多订阅按优先级、A 满自动切 B,桩三道闸);`reportResult` 写 `customerId` + `CardTokenUsage`;`card-migration` 后用量延续;回填脚本正确性;AccessKeyStore DB 读取点 |
| **链路/契约** | `app-auth` 订阅数组契约(Go ↔ server);portal/账户接口契约(web ↔ server);`leaseToken` 回传 `activeSubscriptionId`;前后端类型对齐(`types/index.ts` ↔ DTO) |
| **E2E**(Playwright web + app) | 注册 → 多订阅 → 拖拽优先级 → 使用 → A 耗尽 → **自动切 B → 主界面当前在用变 B、母号血条更新**;老卡登录 → 自动转订阅 → 用量延续 |
| **系统级** | 影子数据跑 A 迁移(零中断 + 归属正确);并发 `leaseToken` 接力(多设备同账户抢额度);故障注入(全订阅满 / 母号不可用 / 迁移中途崩,复用 card-migration crash-ordering);性能(账户化后 `leaseToken` 延迟、聚合大表查询) |

## 6. 实施阶段(TDD 顺序,风险递增)
1. 数据模型(`priority` / `customerId`)+ 写入填 `customerId`。
2. `SubscriptionScheduler` 接力(单测先行)。
3. `leaseToken` 账户化(集成)。
4. `app-auth` 订阅数组 + 优先级接口(契约)。
5. 前端多订阅 + 优先级 + 当前在用(E2E):web 列表页 + app 选择/切换。
6. 迁移回填 + AccessKeyStore 退役(系统级)。
7. 用量统计账户聚合(console / portal / 运维视图)。

## 7. 风险与缓解
- `leaseToken` 入口改动大 → 阶段 3 充分集成 + 并发测;灰度(先账户化解析,接力 feature flag)。
- AccessKeyStore 退役影响冷启 / 并发 → 阶段 6,读取点逐个切 + 缓存 + 性能测;文件作过渡。
- 接力增加 `leaseToken` 延迟(遍历订阅) → 预检轻量(内存计数器),多数账户订阅数少;缓存优先级。
- 历史回填大表 → 分批;无主行容忍 null。

## 8. 待定项
- 订阅优先级 UI:拖拽 vs 上下移(实现时定,E2E 覆盖行为)。
- `CardTokenUsage` → `AccountTokenUsage` 重命名时机(过渡期先加列;终态重命名作收尾)。
- 接力"恢复时间"展示:全满时返回各订阅最早恢复 `resetMs`(已定),前端提示文案待定。
