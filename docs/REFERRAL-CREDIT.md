# 推广返点 · 余额抵扣 设计文档

> 玩法:推广别人下单 → 推广人按订单金额返 **10%** 为站内余额(`creditCents`)→
> 余额**只能用于购买商品**,不可提现。净价仍高于底价,留出毛利与代理空间。

## 实现状态(2026-06-22)

分支 `feat/web-referral-and-i18n-trim`,均带测试、server/web tsc 全绿:

- ✅ **返点默认 10**:`resolveReferralPercent` 空/非法 → 10;`.env`/`.env.example` 改为留空走默认。
- ✅ **余额抵扣消费端**:`PlanOrder.creditAppliedCents` + 迁移;`createCatalogOrder(useCreditCents)` 夹断 [0,min(余额,价)]、原子扣减、payable 计算;全额抵扣走 `CREDIT` 内部单即时激活;作废/取消/超时/退款(toC + console)全路径回补余额;返点按实付计(余额部分不再返)。8 个集成测试。
- ✅ **结账页余额抵扣 UI**:`catalog-order-dialog` 加「使用余额抵扣」开关(切换=重新下单),全额抵扣显示「余额开通」,新增 UI 测试。
- ✅ **重新启用 web 用户中心返佣页**:`/account/referral` 恢复真实页 + 顶部导航入口。
- ✅ **web 后台分享链接 + 分享记录**:客户详情页展示可复制分享链接;聚合「返佣」记录页本就在 console 导航;订单暴露 `creditAppliedCents`。
- ✅ **客户端(桌面)分享链接**:后端 `POST /api/app/referral`(复用 ReferralService);Go `GetReferralInfo()` + Wails 绑定;`SettingsPage` 账户卡加分享链接+复制+返佣余额/已邀请数(zh-CN/en i18n)。Go build / 前端 tsc 通过;**Wails GUI 实机构建未在本环境验证**。

下文为原始设计(实现细节以代码为准)。

---

## 1. 现状盘点

### 1.1 已实现 —— 返点发放端(无需改动)

| 能力 | 位置 |
|---|---|
| 用户邀请码 `referralCode` + 上级 `invitedById` | `prisma/schema.prisma` · `model Customer` |
| 余额字段 `creditCents`(整数,单位:分) | `model Customer` |
| 返点流水 `ReferralReward`(`PENDING` / `GRANTED` / `REVOKED`) | `prisma/schema.prisma` |
| 下单时快照 `PlanOrder.referrerId` | `billing.service.ts` · `resolveReferrerId()` |
| 付款回调里自动返 `floor(amountCents * percent / 100)`,给推广人加余额 + 落 `ReferralReward` | `apps/server/src/leasing/account/billing/epay-callback.service.ts:194-221` |
| 返点比例开关 `EPAY_REFERRAL_PERCENT`(`.env`,默认 `0` = 关) | `.env.example:100` |
| 用户返点页 / 汇总 API | `referral.service.ts`、`GET /api/account/referral` |
| 后台返点管理 | `apps/server/src/leasing/console/referral-admin/` |

### 1.2 缺失 —— 余额消费端(本文档要做的)

全仓 `creditCents` 仅有「加 / 读」,**从无「扣」**。下单算价
(`billing.service.ts` · `createCatalogOrder` → `computePurchase`)完全不看余额。
因此「只能用来买商品」这一核心目前不存在。

---

## 2. 关键决策(已定)

| 项 | 决策 |
|---|---|
| 返点比例 | `EPAY_REFERRAL_PERCENT` 由 `0` 改 `10` |
| 单笔抵扣上限 | **最高 100%**(余额可全额支付一单) |
| 抵扣与手续费先后 | 余额先抵**基础价**,epay 手续费按抵后剩余金额计算 |
| 全额抵扣的单子 | epay 无法收 ¥0 → 改走**内部已支付通道**(同 `GRANT`,不生成支付链接) |
| 余额提现 | 不支持,仅站内消费 |

---

## 3. 数据模型变更

`model PlanOrder` 增加一个快照字段(`prisma/schema.prisma:682`):

```prisma
creditAppliedCents Int @default(0)  // 本单使用余额抵扣的金额(分),用于审计与失败退款
```

- 不新增表;余额扣减仍落在 `Customer.creditCents`。
- `ReferralReward` 不动(那是赚的一端)。
- 迁移:`pnpm --filter server prisma migrate dev`(SQLite,见 [pinai MySQL vs GFA SQLite] 记忆——本仓是 SQLite)。

> 可选增强(本期不做,留待对账需求):独立 `CreditLedger` 流水表,记录每笔
> 加/扣(来源订单、类型 EARN/SPEND/REFUND)。当前用 `PlanOrder.creditAppliedCents`
> + `ReferralReward` 已足够溯源,先不过度设计。

---

## 4. 核心流程

### 4.1 下单(`createCatalogOrder`)

入参新增可选 `useCreditCents`(用户想用的余额,分)。

```
1. computePurchase(selection) → baseCents               // 现有逻辑
2. applied = clamp(useCreditCents, 0, min(余额, baseCents))   // 上限=基础价,可达 100%
3. 原子扣减余额:
     UPDATE Customer SET creditCents = creditCents - applied
       WHERE id = ? AND creditCents >= applied            // 条件更新防并发重复花
     扣减影响行数 = 0 → 抛错(余额已被其他单占用)
4. payable = baseCents - applied
5. 分支:
   a. payable == 0  → 走内部已支付通道(payChannel=GRANT 口径),
                       立即激活订阅,creditAppliedCents=applied,status=PAID
   b. payable  > 0  → 现有 epay 流程,但:
                       amountCents = payable + fee(payable)   // 手续费按抵后金额
                       记 creditAppliedCents=applied,status=PENDING
```

落库 `PlanOrder` 时一并写 `creditAppliedCents`。

### 4.2 失败 / 超时 —— 必须退余额(最易漏钱处)

PENDING 单若 `creditAppliedCents > 0`,在以下路径回补余额:

- **超时作废**:`apps/server/src/leasing/account/billing/order-expiry.service.ts`
- **用户/系统取消**:取消路径
- **被新单顶替**:`createCatalogOrder` 里 `superseded`(作废旧 PENDING)逻辑,line ~180

回补同样用原子自增:`creditCents = creditCents + order.creditAppliedCents`,
并把该单 `creditAppliedCents` 归零或标记已退,避免重复退。

### 4.3 与返点发放的关系(防止套利)

返点在付款回调里按 `amountCents`(实付毛额)计算。由于余额抵扣后
`amountCents` = 抵后金额,**用余额买的部分不再产生新返点**——天然防止
「自返点 → 花余额 → 再返点」的循环套利。需在测试中固化这条不变量。

---

## 5. 前端 / 后台(第 2 期)

- 结账页 `apps/web/.../account/(main)/billing/plans`:展示余额、「使用余额」开关与金额、实时重算应付总额。
- 后台 `console/.../plan-orders`:列表/详情展示 `creditAppliedCents`,供客服核对。

---

## 6. 落地步骤与测试(TDD)

| # | 步骤 | 关键测试 |
|---|---|---|
| 0 | `.env` 把 `EPAY_REFERRAL_PERCENT` 设 `10` | —(配置) |
| 1 | schema 加 `creditAppliedCents` + 迁移 | 迁移生成、默认 0 |
| 2 | `createCatalogOrder` 抵扣逻辑 | 部分抵扣;全额抵扣→GRANT 通道;`useCreditCents` 超额被夹断 |
| 3 | 原子扣减 | **并发两单只成功扣一次**(防重复花) |
| 4 | 超时/取消/顶替退余额 | 退一次且仅一次;`creditAppliedCents` 归零 |
| 5 | 返点不变量 | 用余额买的部分不产生新返点 |
| 6 | 前端 + 后台展示 | —(手测/E2E) |

测试落点参考现有套件:`apps/server/src/leasing/account/billing/__tests__/billing-integration.spec.ts`、`epay-callback.service.spec.ts`。

---

## 7. 第 3 期(可选)代理分级

截图「给代理留了空间」当前仅指**毛利空间**,非功能。若要做多级代理:
给 `Customer` 加 `tier` + `commissionPercent`,付款回调读每人的比例
替代单一 `EPAY_REFERRAL_PERCENT`。建议第 1、2 期跑通后再评估。

---

## 8. 风险清单

- **重复花**:并发下单必须靠条件更新(`WHERE creditCents >= applied`)兜底,不能先读后写。
- **漏退**:任何使 PENDING 单不再可能转 PAID 的路径,都必须回补余额——逐一覆盖测试。
- **¥0 单**:epay 收不了 0,全额抵扣务必转内部通道,否则下单即失败。
- **手续费口径**:余额抵基础价、手续费按抵后算,避免用户用余额还要为「原价手续费」买单。
