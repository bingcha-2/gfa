# 套餐结构重设计 + 配置去影子

- 日期:2026-06-12
- 状态:设计已确认,待写实现计划
- 范围:`apps/server`(leasing 计费/限额)+ `apps/web`(用户购买页 / 后台配置)

---

## 1. 背景

现状链路:套餐 `Plan` → 购买快照成 `Subscription`(数据库)→ `entitlement-sync` 投影成 `access-keys.json` 里的"影子 access-key"记录 → 限额引擎(token-server)读影子记录做鉴权/限额。

`access-key`(卡密)是历史运行时凭证;新账号体系已把对外销售迁移到"账号 + 订阅",卡密只剩 `bind-card` 迁移入口,不再新增。

两个问题要解决:

1. **套餐结构**:需要用极少的对外 SKU,覆盖老卡密"每张卡可任意配置各维度限额"的灵活性,同时分类展示、把选择权交给用户、价格由选配叠加得出。
2. **去影子**:购买产生 `Subscription` 后又投影出一份文件影子,是冗余的双份存储。希望 `Subscription` 成为配置的唯一真相源,限额引擎直读订阅。

---

## 2. 目标 / 非目标

### 目标
- 套餐改为"**两条供给线 + 少量选配旋钮**"的可配置产品;价格 = 基础 + Σ(各旋钮加价)。
- 旋钮全部映射到**现有 `Subscription` 字段**,不新增订阅字段。
- **配置层去影子**:限额引擎读配置(上限/绑定/权重/有效期)时直接读 `Subscription`,新订阅不再生成或依赖 `access-keys.json` 影子记录。

### 非目标(明确不做)
- **不改用量计数机制**:用量维持"内存现算 5h/周窗口 + 异步批量写 `CardTokenUsage` 数据库 + 启动从该表恢复"。
- **不引入 Redis**:单机内存方案够用;多机水平扩展是未来话题,届时只改用量读写一处。
- **不删除老卡密 / `access-keys.json`**:老卡密路径原样保留、自然退役;只为新订阅建"无影子"路径,两条路径并存。
- **不做多时长档**(季付/年付):有效期先单一周期(月)。
- **不做"首次使用才起算有效期"**:新订阅购买即起算 `expiresAt = startsAt + durationDays`。(例外:`bind-card` 迁移的老卡密订阅沿用其原有有效期语义,见 §5.5。)

---

## 3. 套餐结构(用户视角)

### 3.1 顶层:两条平行线(第一级分类)

| 线 | 供给方式 | 卖点 | 核心计价旋钮 |
|---|---|---|---|
| 🟦 **号池线** | 共享号池动态调度 | 便宜 | **用量**(小 / 大) |
| 🟧 **绑定线** | 锁定固定上游号 | 稳定、可独享 | **独占度**(共享人数 1 / 2 / 4 / 8) |

两条线均为**纯选配**(无预设档):用户在该线下逐个旋钮选择,价格实时叠加。

### 3.2 旋钮清单

| 旋钮 | 号池线 | 绑定线 | 用户可选 |
|---|---|---|---|
| 产品(多选 Claude/Codex/Gemini) | ✓ | ✓ | ● 暴露 |
| 用量(小 / 大) | ✓ 核心 | — | ● 暴露 |
| 共享人数(1 / 2 / 4 / 8 人,1 人独号) | — | ✓ 核心 | ● 暴露 |
| 设备数(N 台) | ✓ | ✓ | ● 暴露 |
| 有效期(单一周期) | ✓ | ✓ | ● 暴露 |
| 限额窗口(5h + 周) | 锁死 | 锁死 | 🔒 后台固定,不暴露 |

要点:
- 号池线**没有**独占度旋钮(纯共享,不细分"拼车")。
- 绑定线**没有**用量旋钮 —— 独占号的天花板就是该号的真实配额,人为设上限等于自我阉割;共享时按"共享人数"分份额。
- "桶/周上限"等技术维度跟随旋钮在后台自动算,不进用户界面。

### 3.3 旋钮 → 数据库字段映射(全部复用现有 `Subscription` 列)

| 用户旋钮 | 号池 | 绑定 | `Subscription` 字段 |
|---|---|---|---|
| 线(模式) | 号池 | 绑定 | `bindings` 空 / 锁 `accountId` |
| 产品(多选) | ✓ | ✓ | `productEntitlements` |
| 用量 小/大 | ✓ | — | `bucketLimits` + `weeklyTokenLimit` |
| 共享人数(1/2/4/8 人) | — | ✓ | `weight` = 8 / 4 / 2 / 1(capacity = 8) |
| 设备数 | ✓ | ✓ | `deviceLimit` |
| 有效期 | ✓ | ✓ | `durationDays` → `expiresAt` |
| 限额窗口 | 🔒 | 🔒 | `windowMs = 5h`(+ 周窗口) |

**结论:无需新增 `Subscription` 字段。** 号池 / 绑定由 `bindings` 空 / 非空区分;独占度由现有 `weight`(1~8)承载,fair-share 按权重分号配额。号池线的 `weight` 取后台固定默认值(纯共享,不作卖点)。

---

## 4. 定价模型

- 公式:**最终价 = 基础 + Σ(每个旋钮选项的加价)**(纯加法叠加)。
- 加价数值来自后台一张**价格表**,改价只改数据、不碰代码。
- 价格表存储:`SiteSetting` 表中一条 JSON(key 形如 `pricing-config`),低频读、可进程缓存。

价格表结构(示例):

```jsonc
{
  "pool":  {                       // 号池线
    "base": 900,                   // 分;起步(含首个产品+小用量)
    "product": { "claude": 0, "codex": 1500, "gemini": 1200 },
    "usage":   { "small": 0, "large": 3000 },
    "devicePerExtra": 900
  },
  "bind": {                        // 绑定线
    "base": 0,
    "product": { "claude": 15900, "codex": 17900, "gemini": 13900 },
    "share":   { "1": 0, "2": -4000, "4": -7000, "8": -9000 }, // 人越多越便宜
    "devicePerExtra": 900
  },
  "durationDays": 30
}
```

- 数值仅为占位示例,实际由运营在后台填。
- 用量档(`small` / `large`)对应的实际 `bucketLimits` + `weeklyTokenLimit` 数值,在后台"用量档定义"里配置(见 §6)。

---

## 5. 落地架构:配置去影子(方案 A)

### 5.1 现状三条数据来源(去影子前)

| 关注点 | 当前真相源 | 是否已脱离文件 |
|---|---|---|
| 鉴权(谁、能用哪些产品、有效期) | `session-token-resolver` 查 **数据库 `Subscription`/`Customer`/`Device`** | ✅ 已是数据库 |
| 用量计数(5h/周窗口) | 内存现算;写 **数据库 `CardTokenUsage`**;启动从该表恢复 | ✅ 文件不存用量明细 |
| **配置**(`bucketLimits`/`bindings`/`weight`/有效期/状态) | 限额引擎从 **`access-keys.json` 影子 record** 读 | ❌ 仍走文件影子 |

证据:`session-token-resolver.ts`(查 `prisma.subscription.findMany`)、`access-key-store.ts` 的 `serializable()`(写文件时剥离 `tokenUsageEvents`)、`token-usage-tracker` 批量写 `CardTokenUsage`、`lease-service.ts` `onModuleInit` 从 `CardTokenUsage` 恢复。

→ **唯一还走影子的是"配置"**,而这些字段 `Subscription` 表里本就有一份。去影子 = 把配置读取从文件改为读订阅。

### 5.2 改动点

1. **订阅配置解析器(新)**:输入 `subscriptionId`,从 `Subscription` 读出 `productEntitlements`/`bucketLimits`/`weeklyTokenLimit`/`weight`/`bindings`/`windowMs`/`expiresAt`/`status`,解析 JSON 后返回限额引擎需要的配置对象。带短 TTL 进程缓存(默认 60s);订阅**续期/取消/退款**时主动失效该订阅缓存。
2. **用量窗口存储解耦(关键)**:当前用量内存数组(`tokenUsageEvents` / `weeklyTokenUsageEvents`)寄生在影子 record 上。去影子后改挂在**独立内存结构**(key = `subscriptionId`),只存窗口事件、不含配置。启动恢复逻辑(从 `CardTokenUsage`)指向该结构。
3. **限额引擎读取改造**:`resolveFromRequest` / `validateRecord` 中,**配置**改从"订阅配置解析器"取,**用量**改从"用量窗口存储"取;不再 `byId.get(cardId)` 取影子 record(仅老卡密路径保留)。
4. **`entitlement-sync` 改造**:新订阅激活/续期时**不再 upsert 配置到 `access-keys.json`**;绑定线的"座位分配"(`assignSeatForProduct`)逻辑保留,分配结果照旧写回 `Subscription.bindings`(现已有此步)。订阅过期/取消不再写影子,改为让配置缓存失效。

### 5.3 购买链路(去影子后)

```
用户配好旋钮 → 下单支付
  → 写一条 Subscription(快照旋钮 = 现有字段)
  → 绑定线:分配上游座位,结果写回 Subscription.bindings
  → 完。
限额引擎运行时:resolver 查 Subscription 配置(带缓存)+ 内存用量窗口 → 鉴权/限额。
```

一份数据(`Subscription`),无第二份文件影子。

### 5.4 老卡密共存

`access-keys.json` 及其中的老卡密记录**原样保留**,继续走 `AccessKeyStore` 影子路径;新订阅走 §5.2 的无影子路径。两条路径在限额引擎入口分流(看凭证解析出的是老卡密 key 还是订阅 session)。老卡密随 `bind-card` 迁移与到期自然退役,届时可整体下线该文件。

### 5.5 卡密转移(bind-card)在去影子架构下的行为

`bind-card` 是老用户过渡通道(非新增卡密)。去影子后其**输出端必须调整**,否则迁移产物会自相矛盾地仍是一条影子。

现状:`POST /api/account/bind-card` 在 `access-keys.json` 找到老卡密 record,创建一条 `planId: null` 的 `Subscription`(`id` 沿用 record.id 保持连续),并原地把老 record 的 key 改写为 `backingKeyValue` —— 迁移产物仍是影子。

去影子后的目标行为:

1. **输入端不变**:仍从 `access-keys.json` 读老卡密配置(老卡密本就在那)。
2. **创建 `Subscription` 快照配置**(现状已有),`id` 沿用 record.id。
3. **迁移产物脱离影子**:这条订阅走 §5.2 的"配置读订阅"路径;老卡密 record 仅标记为已迁移/作废(防原卡密字符串重用),不再作为运行时配置来源。
4. **用量延续**:用量窗口 key = `subscriptionId` = 老 record.id,`id` 连续保证迁移前后用量/窗口不断档,用户无感。
5. **有效期沿用老语义**(对 §2 的例外):迁移订阅的 `expiresAt` /「未用过则首用起算」沿用老卡密,不套用新订阅「购买即起算」。

UI:保留「绑定卡密」入口,作为老用户过渡通道,直到老卡密整体退役。

---

## 6. 后台配置(运营视角)

运营不再"逐张发卡",改为配置三样规则:

1. **价格表**:各旋钮加价(§4 的 JSON),改数字即调价。
2. **号源**:号池备号 + 绑定线可绑的上游账号 —— 复用现有 rosetta 账号 / 号池管理。
3. **用量档定义**:`small` / `large` 对应的 `bucketLimits`(每产品 5h 桶上限)+ `weeklyTokenLimit` 数值。

配好后用户自助下单,系统按价格表计价、按号源自动分号、生成订阅。

---

## 7. 数据模型变更小结

- `Subscription`:**不加字段**(旋钮全部复用现有列)。
- 新增价格表存储:`SiteSetting` 一条 JSON(`pricing-config`)。
- 用量窗口:进程内存结构(非持久;启动从 `CardTokenUsage` 恢复,现状已有)。
- `access-keys.json`:不删,仅老卡密使用。

---

## 8. 风险与边界

- **配置缓存一致性**:订阅续期/取消/退款必须触发对应缓存失效,否则限额读到旧配置。
- **用量宿主解耦回归**:解耦后必须保证 5h/周窗口的计算口径(缓存折扣 ×0.1、CU 加权、周=5h×5 默认)与现状逐字节一致;需回归测试覆盖。
- **座位分配并发**:绑定线分号沿用现有写锁/事务,避免两笔并发购买抢同一座位。
- **绑定线无人为用量上限**:天花板 = 号真实配额,按 `weight` 份额经 fair-share 分配;需确认 fair-share 在"配置读订阅"后仍拿得到 `weight`。
- **凭证分流**:限额引擎入口要能稳妥区分"老卡密 key" vs "订阅 session",避免新订阅误入影子路径。

---

## 9. 实现顺序建议

1. 订阅配置解析器 + 缓存(读路径,旁路,不改写路径)。
2. 用量窗口存储解耦(与配置分离),回归窗口口径。
3. 限额引擎切换:配置走解析器、用量走窗口存储;新订阅停止写影子。
4. `entitlement-sync` 去掉配置镜像写入(保留座位分配)。
5. 调整 `bind-card`:迁移产物走无影子路径(不再原地变影子),用量按 `subscriptionId`(= 老 record.id)延续,有效期沿用老语义。
6. 套餐结构前端(两条线纯选配 + 实时价)+ 后台价格表/用量档配置。
7. 端到端:下单 → 订阅 → 无影子限额生效。
