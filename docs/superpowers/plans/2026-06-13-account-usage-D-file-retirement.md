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

## ⚠️ 咬合依赖(执行时务必按序,否则开安全洞)
**「去文件写 ↔ 去文件读 ↔ 删 flush」三者咬死,必须当一个整体按序做:**
- `card-migration` 的文件写(`upsertKeyRecord`)作用是**让旧卡密失效**(把老卡 key 改成 backingKeyValue)。
- 若先删文件写、但文件仍被读(`byKey` 还认老卡 key)→ **迁移后老卡密仍能认证 = 安全洞**。
- 正确顺序:① 先让认证完全走 DB(`findByKey` 已支持订阅卡 ✅ D1a;再删 `byKey`/`readAll` 文件读)→ ② 再删 `card-migration` 文件写 → ③ 最后删 `flush`(配 `hydrateWindowsFromUsageLog` 重建窗口的集成测)。
- 每步之间跑全回归,且专门验:**「迁移后老卡 key 确实认证失败」+「重启后限流窗口==删 flush 前」**。

## 执行进度 / 建议
- ✅ **D1a 已落地**(`0f7061d`):`findByKey` 认订阅卡,文件卡行为不变 —— 这是唯一能安全独立落地的准备步。
- 🔬 **D2-1 验证(已完成 · enforcement 级,2026-06-13)**:核实「每次部署漏额度」假设 —— **成立**。
  - 复现链:`subscriptionToLimitRecord` 不产出 `windowStartedAt` → pre-D2(HEAD)`hydrateWindowsFromUsageLog` 只 push 事件、不重建起点 → 纯订阅卡(号池线)重启后首次请求进 `validateRecord`,`resetWindowIfExpired`/`resetWeeklyWindowIfExpired` 见起点===0 即清窗 + 重设 now → 满额 5h 桶 + 周窗被清零、本应 429 的请求被**放行**(enforcement 真放行,非仅状态层)。
  - 修复确认:`reconstructUseAnchoredWindow`(`token-billing.ts`)+ `reconstructSubscriptionWindows`(`access-key-store.ts`,`hydrate` 末尾调用)**均已在 working tree、尚未提交**;改走真实 `hydrateWindowsFromUsageLog` → 同份满额用量被正确拦成 **429**。即 D2 核心修复已就位,待提交。
  - 证据:`apps/server/src/leasing/token-server/__tests__/deploy-quota-leak-repro.spec.ts`(8 用例);`pnpm vitest run src/leasing/token-server` → 23 files / 404 tests 全绿,repro 文件单跑连测稳定(`Date.now()` 已 mock)。
  - ✅ bucket 覆盖(对齐「对所有 bucket 完备」):号池 5h 桶 **`anthropic-claude`(CU)· `antigravity-gemini`(原始计量)· `codex-gpt`(CU)** + 周窗 **显式 `weeklyTokenLimit`** 与 **派生 `5h×R`**;PRE(满额清零放行)/ POST(hydrate 重建后 429)均覆盖。
  - ⚠️ 仍未覆盖(本文件范围外):**绑定线 5h**(走 `alignedResetAt + bucketUsageInWindow`,不读 `windowStartedAt`、非 reconstruct 路径)的 enforcement 级满额拦截 —— 其窗口状态级行为已由 `access-key-store-deshadow.spec.ts`(reconstruct 跳过绑定线 5h)+ `aligned-enforce.spec.ts` 覆盖;删 flush 前若要对绑定线也做满额 429 回归,需另起用例。
- 🔒 **剩下的咬合三步(去文件读 + card-migration 去文件写 + 删 flush)** 动限流命根子 + 涉安全洞,**强烈建议一个专注会话整体推**,边做边验上面两条断言。
- **D3**(后台卡管理停用 + cleanup 改 DB)跟在咬合三步之后收尾。
