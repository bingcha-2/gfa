# 客户端双血条额度显示设计

> 日期:2026-06-08
> 范围:bcai-wails 桌面客户端「模型用量」面板

## 背景 / 问题

客户端「模型用量」血条目前只显示底层号的**上游余量**(`boundFractions`)。两类信息在 UI 上完全看不到:

1. **卡级 `bucketLimits`**(static 卡在后台设的 token 上限)——只在本地 429 拦截那一下才间接生效,界面无任何提示。
2. **绑定卡的「整号 vs 我的份额」区分**——绑定卡那根条现在显示的其实已经是 `fairShareQuota`(我的份额),但「整个号还剩多少」没单独露出。

**痛点(防误导)**:号显示「充足 87%」,但用户这张卡其实只剩 40%、快用爆——用户被误导。

## 目标

每个模型桶最多显示**两根血条**,让用户一眼看到真正卡住自己的那个:

- **号余量条** = 整个号的上游余量
- **我的卡条** = 这张卡自己的剩余额度

默认只给 `%` + 状态词(充足/紧张/已用尽),延续「不露 token 数字」风格;**点击「我的卡」条展开**才看具体数字。

## 显示规则(数据来源)

| 条 | 数据来源 |
|---|---|
| **号余量** | 始终 = `accountBuckets`(整个号上游余量) |
| **我的卡**(static 卡) | 本地 `localQuota`:`(limit - used) / limit`,数据客户端已有(`opusUsed/opusLimit` 等家族级字段) |
| **我的卡**(绑定卡 dynamic) | `fairShareQuota` 份额 |
| **我的卡**(无限号池卡) | 无 → **不显示这条,降级单条** |

- 每条颜色/状态词**各自独立**计算(`bloodBarFromFraction`),谁紧用户自己看得出。
- 「号余量」条不展开数字(上游通常只有 % 无精确值)。

## Codex / Claude 账号级窗口

这两类有账号级「5h + 周」双窗口条(`codexQuota` / `claudeQuota`)。规则:在 `5h` + `周` 两根号窗口条之下,**再加一条「我的卡」**(static 卡有 bucketLimits 时),最多 3 条。不与号窗口合并。

## 改动范围(集中在客户端,服务端不改)

**前置事实**:lease 响应**已同时下发** `accountBuckets`(整号)+ `fairShareQuota`(份额)([lease-service.ts:556/568](../../../apps/api/src/lease-core/lease-service.ts));static 本地额度客户端 `localQuota` 已有。所以服务端无需改动。

1. **`bloodbar.go`** — 当前 `recordFairShareQuota` **覆盖**了 `recordAccountBuckets`,丢了整号那份。改为 `bucketQuota` 同时保留两份:
   - `accountFraction`(整号,来自 `accountBuckets` / `boundAccount.fraction`)
   - `myFraction` + `myResetAt`(份额,来自 `fairShareQuota`)
   - `snapshotBoundFractions` 拆成两个 map(整号 / 我的份额)。
2. **`leaser_status.go` / `app.go`** — status JSON 输出两份 fraction + resetMs(`accountFractions` + `myFractions`);static 的 `localQuota.used/limit` 继续下发。
3. **`useAppStore.ts`** — 接收新结构(`accountFractions` / `myFractions`),保留现有 `opus/gemini/codexUsed+Limit`。
4. **`UsageBar.tsx` / `DashboardPage.tsx`**:
   - 每桶按规则渲染号余量条 + 我的卡条(降级单条)。
   - 我的卡条:static 用 `localQuota` 家族字段算 `%`;绑定用 `myFraction`。
   - 「我的卡」条**可点击展开**具体数字(新增展开态)。
   - codex/claude:5h/周 + 我的卡。
5. **测试** — `UsageBar` 双条 + 展开 + 各卡类型降级的组件测试;`DashboardPage` 渲染快照。

## 非目标

- 不暴露「号余量」条的精确 token 数。
- 不改服务端计费 / 额度 enforce 逻辑。
- 不改发卡端(web 控制台)。

## 展开态字段

- static:`已用 50M / 上限 50M · 5h 窗口 · 2h10m 后重置`
- 绑定卡:`份额 1/3 · 本期剩 35%`
