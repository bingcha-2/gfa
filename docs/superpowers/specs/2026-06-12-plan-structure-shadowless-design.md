# 套餐结构重设计 + 表瘦身 + 配置去影子

- 日期:2026-06-12
- 状态:设计已确认,待写实现计划
- 范围:`apps/server`(leasing 计费/限额)+ `apps/web`(购买页 / 后台)+ `apps/app`(客户端购买展示)

---

## 1. 背景

现状:`Plan`(固定套餐模板)→ 购买时全量快照成 `Subscription` → `entitlement-sync` 再投影成 `access-keys.json` 的"影子 access-key" → 限额引擎读影子。

三处臃肿:
1. **`Plan` 与 `Subscription` 字段几乎一模一样** —— 购买就是把 Plan 复制一份,纯选配后 Plan 已无意义。
2. **`Subscription` 是大宽表** —— 号池线、绑定线各用一半字段,另一半恒为 null。
3. **影子是第三份冗余** —— 同一份配置在 DB 列 + 文件影子各存一遍。

本设计:套餐改为"两条线纯选配",并借机把表瘦成 **`PlanCatalog` + `Subscription`** 两张职责不同的表,顺手去影子。

---

## 2. 目标 / 非目标

### 目标
- 套餐 = "号池线 / 绑定线"两条线,纯选配,价格 = 基础 + Σ(旋钮加价)。
- 表瘦身:**删 `Plan`**;新增**版本化 `PlanCatalog`**(可发布、给客户端渲染);`Subscription` 收敛成"通用列 + 一个 `config` JSON"。
- 配置去影子:`Subscription.config` 即限额引擎要读的格式,引擎直读订阅,新订阅不再写 `access-keys.json`。

### 非目标(明确不做)
- 不改用量计数机制(维持内存现算 5h/周 + 异步批量写 `CardTokenUsage` + 启动从该表恢复)。
- 不引入 Redis(单机内存够;多机扩展是未来,届时只改用量读写一处)。
- 不删除老卡密 / `access-keys.json`:老卡密路径原样保留、自然退役。
- 不做多时长档(季付/年付):有效期先单一周期。
- 不做"首次使用才起算":新订阅购买即起算 `expiresAt = startsAt + durationDays`(例外:`bind-card` 迁移订阅沿用老卡密语义,见 §9)。

---

## 3. 套餐结构(用户视角)

### 3.1 两条平行线(第一级分类)

| 线 | 供给 | 卖点 | 核心旋钮 |
|---|---|---|---|
| 🟦 **号池线** | 共享号池动态调度(**不分等级**·混档) | 便宜 | **用量**(小 / 大) |
| 🟧 **绑定线** | 锁定固定上游号 | 稳、可独享 | **等级**(Pro/5x/20x)× **共享人数**(1/2/4/8) |

两条线均为**纯选配**(无预设档),价格实时叠加。

### 3.2 旋钮清单

| 旋钮 | 号池线 | 绑定线 | 暴露 |
|---|---|---|---|
| 产品(多选 Claude/Codex/Gemini) | ✓ | ✓ | ● |
| 用量(小 / 大) | ✓ 核心 | — | ● |
| 账号等级(按产品:Claude Pro/5x/20x …) | — | ✓ 核心 | ● |
| 共享人数(1 / 2 / 4 / 8 人,1 人独号) | — | ✓ 核心 | ● |
| 设备数(N 台) | ✓ | ✓ | ● |
| 有效期(单一周期) | ✓ | ✓ | ● |
| 限额窗口(5h + 周) | 锁死 | 锁死 | 🔒 不暴露 |

### 3.3 两条线的本质分工(为什么旋钮这样分)

- **号池线 = 卖用量**:同产品的号在池里**混档动态调度**(`selectAccount` / `availableAccounts` 只看 `poolEnabled`/`enabled`/可用性/冷却,**不看 level**,见 [lease-service.ts:1262](apps/server/src/leasing/lease-core/lease-service.ts:1262))。所以用户**选不了等级**;我们用 `bucketLimits` 设 token 上限,卖"小 / 大用量"。
- **绑定线 = 卖号的档次 + 独占**:要锁一个具体号,购买时按 `(产品, 等级, 权重)` 调 `assignSeatForProduct` 选号([entitlement-sync.service.ts:91](apps/server/src/leasing/subscription/entitlement-sync.service.ts:91))。**无用量旋钮** —— 天花板就是该号真实配额,按"共享人数"分份额。
- 账号等级是 **per-product** 的(每个选中的产品各挑一档)。
- 共享人数 → `weight`:capacity = 8,1 人独号 = weight 8,2/4/8 人 = weight 4/2/1。

---

## 4. 表结构(核心)

业务表收敛为**两张**:`PlanCatalog`(全局配置)+ `Subscription`(购买实例)。用量审计表 `CardTokenUsage` 保持不变。**删除 `Plan` 表。**

### 4.1 `PlanCatalog` —— 全局套餐目录(版本化、可发布)

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | String @id | |
| `version` | Int | 版本号,递增 |
| `status` | String | **DRAFT / PUBLISHED / ARCHIVED**(同时至多一条 PUBLISHED) |
| `config` | String | 全局规则 JSON 字符串(SQLite 无 Json 类型,与现有字段一致) |
| `publishedAt` | DateTime? | |
| `createdAt` | DateTime | |

`PlanCatalog.config`(全局规则):
```jsonc
{
  "products": ["anthropic", "codex", "antigravity"],
  "levels": {                         // 各产品有哪些等级(绑定线选)
    "anthropic": ["pro", "max-5x", "max-20x"],
    "codex":     ["plus", "pro"],
    "antigravity": ["pro", "ultra"]
  },
  "usageTiers": {                     // 用量档(号池线):小/大 → 实际上限
    "small": { "bucketLimits": { "anthropic-claude": 50000 }, "weeklyTokenLimit": 250000 },
    "large": { "bucketLimits": { "anthropic-claude": 150000 }, "weeklyTokenLimit": 750000 }
  },
  "pricing": {                        // 价格表(分)
    "pool": { "product": { "anthropic": 6900, "codex": 3900, "antigravity": 3900 },
              "usage": { "small": 0, "large": 3000 }, "devicePerExtra": 900 },
    "bind": { "levelPrice": { "anthropic": { "pro": 9900, "max-5x": 15900, "max-20x": 29900 },
                              "codex": { "plus": 13900, "pro": 19900 },
                              "antigravity": { "pro": 11900, "ultra": 19900 } },
              "share": { "1": 0, "2": -4000, "4": -7000, "8": -9000 }, "devicePerExtra": 900 }
  },
  "durationDays": 30,
  "windowMs": 18000000
}
```
- 编辑存 DRAFT;发布 → 该版 PUBLISHED、旧版 ARCHIVED(留历史、可回滚)。
- 数值与等级档名均为占位示例,实际由运营在后台填;等级档名以实际可绑的号为准。

### 4.2 `Subscription` —— 购买实例(瘦身)

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | String @id | |
| `customerId` | String | 谁买的 |
| `status` | String | ACTIVE / EXPIRED / CANCELLED |
| `startsAt` / `expiresAt` | DateTime | 有效期 |
| `catalogVersion` | Int | 买时的目录版本(溯源 / 价格锁定) |
| `activatedFromOrderId` | String? | 退款对账 |
| `config` | String | **限额配置 JSON 字符串**(用啥放啥、无 null;SQLite 存 String) |
| `createdAt` / `updatedAt` | DateTime | |

**移除的旧列**(并入 `config` 或删除):`planId`、`productEntitlements`、`bucketLimits`、`levels`、`bindings`、`weight`、`deviceLimit`、`weeklyTokenLimit`、`windowMs`、`backingKeyValue`。

`Subscription.config`(购买时**快照展开的实际值**,catalog 改动不影响老订阅):
```jsonc
// 号池线
{ "line": "pool", "products": ["anthropic"],
  "bucketLimits": { "anthropic-claude": 150000 }, "weeklyTokenLimit": 750000,
  "deviceLimit": 2, "windowMs": 18000000 }

// 绑定线
{ "line": "bind", "products": ["anthropic"],
  "levels": { "anthropic": "max-20x" }, "bindings": { "anthropic": 1234 },
  "weight": 8, "deviceLimit": 1, "windowMs": 18000000 }
```

### 4.3 旋钮 → `config` 键 映射

| 旋钮 | 号池 | 绑定 | `config` 键 |
|---|---|---|---|
| 线 | pool | bind | `line`(也由 `bindings` 有无判定) |
| 产品 | ✓ | ✓ | `products` |
| 用量 | ✓ | — | `bucketLimits` + `weeklyTokenLimit` |
| 账号等级 | — | ✓ | `levels` |
| 共享人数 | — | ✓ | `weight`(8/4/2/1) |
| 绑定的号 | — | ✓ | `bindings`(购买时分配) |
| 设备数 | ✓ | ✓ | `deviceLimit` |
| 窗口 | 🔒 | 🔒 | `windowMs`(固定 5h) |

号池 vs 绑定:`config.line` + `bindings` 有无,双重判定。

---

## 5. 定价

- 公式:**最终价 = 基础 + Σ(每个旋钮选项的加价)**(纯加法)。
- 价格表是 `PlanCatalog.config.pricing` 的一部分,改价 = 发布新版 catalog,不碰代码、不动表。
- 下单时按当前 PUBLISHED catalog 计价,并把 `catalogVersion` 记进 `Subscription`(溯源)。

---

## 6. 落地架构:去影子

### 6.1 现状三条数据来源
| 关注点 | 当前真相源 | 已脱离文件? |
|---|---|---|
| 鉴权 | `session-token-resolver` 查 **数据库** Subscription/Customer/Device | ✅ |
| 用量 | 内存现算 + 写 **`CardTokenUsage`**;启动从该表恢复 | ✅ 文件不存用量明细 |
| **配置** | 限额引擎从 **`access-keys.json` 影子** 读 | ❌ 唯一还走文件的 |

### 6.2 去影子:`config` 即引擎格式
`Subscription.config` 的结构**就是**限额引擎原来从影子 record 读的那套(bindings/weight/bucketLimits/weeklyTokenLimit/windowMs/products)。所以:
- 订阅配置解析器:按 `subscriptionId` 读 `Subscription.config`(短 TTL 缓存;续期/取消/退款时失效)。
- 限额引擎 `resolveFromRequest` / `validateRecord`:配置改从解析器取,**不再 `byId.get` 影子**;用量改从"用量窗口存储"(内存,key=subscriptionId)取。
- 用量窗口存储与配置解耦(原来寄生在影子 record 上,现独立)。
- `entitlement-sync` 不再为新订阅写 `access-keys.json`。

### 6.3 号池线跳过座位分配
现状对所有 plan-backed 订阅一律 `assignSeatForProduct`([entitlement-sync.service.ts:75](apps/server/src/leasing/subscription/entitlement-sync.service.ts:75))。新设计:
- **绑定线**:购买时按 `(产品, 等级, weight)` 分配座位,写 `config.bindings`。
- **号池线**:**跳过座位分配**,`config.bindings` 留空,运行时由 `selectAccount` 动态调度。

### 6.4 用量计数:维持现状(§2 非目标),只是宿主从影子 record 改为内存窗口存储(key=subscriptionId)。

### 6.5 老卡密并存:`access-keys.json` 及老卡密记录原样保留,走原影子路径;新订阅走 §6.2。两条路径在限额引擎入口按凭证分流。老卡密随迁移/到期自然退役。

---

## 7. 后台配置 & 客户端

### 7.1 后台
- **套餐配置**:新增 console 页编辑 `PlanCatalog`(改 `config` → 存 DRAFT → 发布)。
- **号源**:沿用现有 rosetta 账号管理(claude-account / codex / antigravity accounts + `poolEnabled` 号池开关)。一行不动。

### 7.2 客户端
- `GET /api/plan-catalog` → 返回当前 PUBLISHED 的 `config`(products/levels/usageTiers/pricing)。
- 客户端(web 购买页 / app)据此渲染两条线、产品、等级、用量、价格,前端实时算价。

---

## 8. 购买 / 续费 / 改配置

- **下单**:按 PUBLISHED catalog 计价 → 建 `Subscription`(快照 `config` + `catalogVersion`);绑定线再分配座位写 `config.bindings`。
- **同配置再买(续费)**:命中一条 `config` 等价的 ACTIVE 订阅 → **延长** `expiresAt = max(now, expiresAt) + durationDays`(沿用现有 `createFromPlan` 的 extend 语义,判断键从 `planId` 改为 `config` 指纹)。
- **不同配置再买**:新建订阅,**与现有订阅并存**(用户可同时持有号池+绑定、不同产品的多条订阅)。同一产品被多条 ACTIVE 订阅覆盖时,沿用现有 `session-token-resolver` 的选择逻辑(选最长寿的一条)。
- **价格锁定**:catalog 改价发新版,在售订阅靠自身 `config` 快照 + `catalogVersion` 不受影响。

---

## 9. 卡密转移(bind-card)在去影子下的行为

`bind-card` 是老用户过渡通道(非新增卡密)。

- 输入端不变:从 `access-keys.json` 读老卡密配置。
- 创建 `Subscription`,`id` 沿用老 record.id(连续);把老卡密配置写进 `config`(line 视 bindings 有无)。
- **迁移产物脱离影子**:走 §6.2 配置读订阅;老卡密 record 标记已迁移/作废,不再作为运行时配置源。
- **用量延续**:用量窗口 key = `subscriptionId` = 老 record.id,迁移前后不断档。
- **有效期沿用老语义**(§2 例外):`expiresAt` /「未用过则首用起算」按老卡密,不套"购买即起算"。
- UI:保留「绑定卡密」入口,直到老卡密退役。

---

## 10. 边界情况(状态矩阵)

### 已确认的处理
- **账号等级对齐(绑定线)**:按 `(产品, 等级, weight)` 选有空闲 share 的号;成功 → 写 `config.bindings`。
- **没有任何 ACTIVE 订阅**:鉴权阶段拒绝;设备数默认上限 1。
- **多订阅共存**:`effectiveDeviceLimit` 取所有 ACTIVE 订阅的 max;token 限额按命中的订阅各自的 `config` 计;同产品多覆盖时 resolver 选最长寿。
- **过期/取消/退款**:`status` 翻 EXPIRED/CANCELLED,配置缓存失效;绑定线座位释放(share 只计 ACTIVE 订阅的 bindings)。

### 待硬化(实现时必须处理,现状即有缺口)
- **等级无配置 / 该等级无空闲号**:绑定线座位分配失败 → 现状是留 UNBOUND + `requiresBinding` 拒绝租赁([entitlement-sync.service.ts:92](apps/server/src/leasing/subscription/entitlement-sync.service.ts:92))。需补:下单前预检可用座位、失败退款/告警/重试队列,**不能让用户付了钱拿不到号**。
- **绑定号被封/失效/下架**:需明确是否自动改绑到同等级其他空号,还是降级/通知。(现状改绑逻辑待确认)
- **号池某产品全忙/耗尽**:`selectAccount` 返回 null → 503;需限流或扩容策略。
- **并发购买抢同一座位**:沿用现有 `withAccessKeysWriteLock` / 事务保证;去影子后改为对应的 DB 事务。

---

## 11. 风险

- **`config` JSON 的查询性**:限额配置进 JSON 后不便 SQL 过滤;但这些字段主要是"读出来喂引擎",极少按它们查,可接受。需要的聚合(如某等级在售数)走 catalog/号源侧统计。
- **配置缓存一致性**:订阅续期/取消/退款必须失效对应缓存。
- **用量宿主解耦回归**:5h/周窗口口径(缓存折扣 ×0.1、CU 加权、周=5h×5)迁移后须逐字节一致,回归测试覆盖。
- **数据迁移**:现有 `Plan`/`Subscription` 独立列 + 老卡密影子 → 新结构,需一次性迁移脚本(老订阅 config 由现列拼出,catalogVersion 给个初始值)。

---

## 12. 实现顺序

1. 加 `PlanCatalog` 表 + 后台编辑/发布 + `GET /api/plan-catalog`。
2. `Subscription` 加 `config`/`catalogVersion`,迁移脚本把旧列灌进 `config`;下单改为写 `config`。
3. 订阅配置解析器(读 `Subscription.config` + 缓存),限额引擎配置读取切到它。
4. 用量窗口存储与配置解耦,回归窗口口径。
5. 号池线跳过座位分配;`entitlement-sync` 停止为新订阅写影子。
6. `bind-card` 迁移产物走无影子路径。
7. 删 `Plan` 表与残留读取;前端购买页(两条线纯选配 + 实时价)。
8. 端到端:配 catalog → 下单 → 订阅 → 无影子限额生效。
