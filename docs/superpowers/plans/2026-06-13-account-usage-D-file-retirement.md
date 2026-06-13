# 子计划 D：access-keys.json 文件退役 路线图

> **状态**:蓝图(D 牵涉计费/限流核心存储,按 subagent-driven 逐 task 细化执行;高风险阶段 D2 建议专注推进)
> 日期:2026-06-13 · 分支:account-system

**Goal:** `AccessKeyStore` 不再读写 `access-keys.json`,卡/订阅唯一真相源是 DB `Subscription`。卡密唯一入口 = 账户 `bind-card`(已有,ID continuity + 用量回填已落地 `91f30a2`)。下线后没 bind-card 的纯文件卡认证失败 —— 预期(卡密弃用)。

**为什么不能一刀切**:`access-keys.json` 现在不只存卡,还兼着 ①**用量限流窗口的持久化**(5h/周状态,`recordUsage` 每次 `markDirty→flush` 写它)② **一整套后台卡管理接口**(创卡/改卡/绑卡/删卡,全直接写它)。一刀删文件会丢限流窗口 + 崩后台卡管理。所以分 3 阶段、按风险递增。

---

## 阶段 D1：认证/绑卡去文件化(低风险)

**目标**:运行时认证和 bind-card 不再依赖文件读。

| Task | 改动 | 锚点 | 风险 |
|---|---|---|---|
| D1-1 | `AccessKeyStore` 加 `subscriptionByBackingKey` 内存索引(`loadSubscriptionRecords` 时建 `backingKeyValue→record`) | `access-key-store.ts` loadSubscriptionRecords(~248) | 低 |
| D1-2 | `findByKey` 改:`byKey`(文件) ‖ `subscriptionByBackingKey`(DB 订阅) ‖ null —— 保持同步签名,O(1) | `access-key-store.ts:433` | 低 |
| D1-3 | `findByMigratedFromKey` 改查内存订阅(不读文件 keys) | `card-migration.service.ts:292` | 低 |
| D1-4 | `card-migration` 删两处文件写(`flush`+`upsertKeyRecord`,~189-193 / 207-208),只留 `tx.subscription.create`(已含 backingKeyValue)+ `reloadPools` 刷内存 | `card-migration.service.ts:189,207` | 中(并发屏障简化,需集成测验 bind-card 后 subscriptionById 同步) |

> 运行时订阅卡认证走 session JWT(cardId)→`findById`→`subscriptionById`,本就不读文件 key 索引;D1 主要把 `findByKey`(bind-card 查旧卡)和 card-migration 文件写去掉。

## 阶段 D2：用量窗口去文件化(⚠️ 高风险 — 动限流核心)

**目标**:限流窗口状态不再写文件,重启从 `CardTokenUsage` 重建。

| Task | 改动 | 锚点 | 风险 |
|---|---|---|---|
| D2-1 | 验证 `hydrateWindowsFromUsageLog`(boot 从 `CardTokenUsage` 重建 5h/周窗口)对所有 bucket 完备 —— 这是删 flush 的前提 | `access-key-store.ts:311` | 高 |
| D2-2 | `recordUsage` 去掉 `markDirty()`(用量只落 `CardTokenUsage` DB,不写文件) | `access-key-store.ts:782` | 高 |
| D2-3 | 删 `flush`/`writeCache`/`serializable`/debounce timer;`validateRecord` 的 writeCache 调用清掉 | `access-key-store.ts:363,370,412` | 高 |

> ⚠️ 搞砸 = 丢限流窗口(用户额度被重置/穿透)。**必须**先用集成测证明"删 flush 后,重启经 hydrate 重建的窗口 == 删之前",再动。建议**专注会话 + 充分回归**。

## 阶段 D3：后台卡管理停用 + 清理改 DB(中风险)

**目标**:随卡密弃用,下线文件卡的后台管理。

| Task | 改动 | 锚点 |
|---|---|---|
| D3-1 | rosetta 后台卡接口(create/update/bind/unbind/delete AccessKey)→ 403/下线 | `rosetta.controller.ts:285-325` · `access-key.service.ts` |
| D3-2 | `cleanupExpiredKeys`/`cleanupUnboundKeys` 改 DB 驱动(标记 `Subscription.status=EXPIRED`,复用 `SubscriptionExpiryService`) | `access-key.service.ts:735,786` |
| D3-3 | `readAll`/`reload`/`rebuildIndex`/文件 I/O 清理;`access-keys.json` 文件删除 | `access-key-store.ts:188,206,225` |

---

## 已完成(不在 D 范围,已落地)
- ✅ bind-card 用量回填(`91f30a2`):转订阅时该卡历史用量归账户。
- ✅ 用量按账户写入(子计划 A)、订阅优先级接力(子计划 B)、portal 账户口径(E1)。

## 验收(D 全部完成)
- `grep -r "access-keys.json" apps/server/src` 仅剩历史注释;`AccessKeyStore` 无文件读写。
- 重启后限流窗口经 `CardTokenUsage` 重建,额度连续(D2 集成测证明)。
- 纯文件卡认证失败、订阅卡正常;bind-card 仍可把卡转订阅 + 回填用量。
- `pnpm vitest run src/leasing` 全绿;`pnpm lint` EXIT 0。

## 执行建议
- **D1**(低风险)可顺着现有节奏 subagent-driven 推。
- **D2**(高风险,动限流核心)建议**单独专注会话**:先补 `hydrateWindowsFromUsageLog` 完备性的集成测(证明"重建窗口==文件窗口"),再删 flush。
- **D3** 跟在 D1/D2 后做收尾。
