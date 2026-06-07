# 用量与剩余(usage-stats)可视化重设计

日期:2026-06-07 · 状态:待评审

## 背景与目标

现有「用量与剩余」页两个痛点(用户反馈):

1. **看不懂**:各模型供给用表格 + "中位数"列,运营不知道"中位数"是啥、也看不出整池状况。
2. **会无限长**:账号水位与绑定卡明细每个账号铺一张卡,账号一多页面爆炸。

目标:**分层**——顶部图表一眼看全局,明细默认折叠按需展开。统计改用图,而非数字表。

范围:不止运营后台(apps/web),还含 **① 服务端 apps/api**、**② 客户端 apps/bcai-wails 的本地用量面板**(同样图表化 + 省钱价校真)、**③ packages/shared 的定价单一源**(服务端权重与客户端省钱共用一份,杜绝两端常量漂移)。

口径前提(一次讲清,贯穿全页):

- **账号水位**(上游剩余比例,modelQuotaFractions / AccountQuotaSnapshot)= **上游实测**。
- **卡级「本窗口已用加权」「累计 Token」** = **实测**(每次请求累加)。
- **卡级「份额剩余 %」** = **估算**:分子(已用)实测,分母(账号总预算)是从 429 学出来的,有误差 → UI 挂「估算」标签;实测数字给主位,估算退辅助。

## 页面结构(自上而下)

### 1. KPI 条(保留)
启用账号 / 当前并发 / 今日 Token / Provider 数。不变。

### 2. Token 用量趋势图(保留)
已含 antigravity/codex/anthropic 三条线。不变。

### 3. 各产品供给总览(替换旧"各模型供给"表 + 中位数)
每个 product 一块;块内每个 model 一张紧凑卡:

- **状态甜甜圈**(B 的环形,但内容=分布而非单一数字):环的各段=各水位档的账号数(耗尽/紧张/偏低/健康/无数据),颜色即状态;圆心写「可用 X/N」(N=池内启用号,X=现在能服务该模型的号)。**这就是"中位数/最低水位"的替代——直接看整池分布,最惨的号=环上红段**。
- 模型名 + 近期水位 sparkline(用 AccountQuotaSnapshot 历史;无快照则不画)。
- 排序:最紧张的模型在前(可用号少 / 有耗尽档占比高优先)。
- **点开某模型** → 展开为完整**水位分布直方图**:Y=账号数,水位档 **chip 可开关**(默认关"无数据",关掉后其余档按新最大值重新缩放);点某档可列出该档的具体账号(下钻)。

> 已决定:Y 轴固定=账号数(不做切换到加权用量)。"无数据"占大头是上游特性(号只在被调用/限流时才有水位),如实显示 + 默认隐藏。

### 4. 绑定卡明细(折叠手风琴,治"无限长")
- 每个**有绑定卡**的账号 = 一行摘要:邮箱 · 套餐 · 状态 · 卡数 · **份额最紧 XX%**(估算标签 + 小血条)。
- 点 ▸ 展开 → 卡表:卡名 / 权重 / **本窗口已用加权(实测)** / 累计 Token(实测) / 请求 / **份额剩余 %(估算)** / 24h 频率条。
- 顶部「**只看告警账号**」开关:只展开份额吃紧(黄/红)的账号。
- 后端已有过滤(只留有绑定卡或有水位的账号)+ `totalAccounts`,保留;页面长度 = 账号行数,不随卡数爆炸。

## 后端改动(apps/api)

1. **`rollupProviderStats`(remote-stats.service.ts)**:每个 model 增加
   `distribution: { exhausted, warn, low, healthy, noData }`(按 `getModelQuotaFraction` 分档计数:`<0.05` 耗尽 / `<0.20` 紧张 / `<0.50` 偏低 / `≥0.50` 健康 / `null` 无数据)。保留 available/poolSize。`lowestRemaining/medianRemaining/lowCount` 可留在 payload 但前端不再主显(下一步可删)。
2. **dashboard 绑定卡项**:`boundCards[]` 增加 `windowWeightedUsed`(本窗口已用加权,实测)。在 `LeaseService.getBoundCardsForAccount` 里从 `fairShareTracker` 暴露(新增只读取数,不改计算)。
3. **fair-share 权重不再硬编码,改为从定价单一源派生**(见下「定价单一源」)。`QUOTA_WEIGHTS[family] = { input:1, output: outputPerM/inputPerM, cache: cacheReadPerM/inputPerM }`。落到当前定价 → claude {1,5,0.10}(不变)、gemini {1,8,0.25}(输出 4→8)、gpt {1,8,0.10}(输出 3→8、缓存 0→0.10)。改价只改 pricing 一处,权重自动跟随。

## 客户端改动(apps/bcai-wails)
两个痛点同治:本地用量面板有数据没画图 + 省钱价过时硬编码。

1. **DashboardPage 加「用量趋势」图**:复用 `GetStats()` 已返回但前端未用的 `dailyHistory`(7天)/`hourlyHistory`(24h)/`chartMode`,画输入/输出堆叠柱,今日(小时)↔近7天切换(chartMode 决定默认)。今日 4 数字 + 模型用量血条 + 绑定账号卡保留。
2. **省钱价按家族真实定价**:`UsageStatsStore.AddTokens` 增加 `family` 参数;`SavedMoneyUSD` 改为 `Σ tokens × 该家族 $/M`(取自下方 embed 的 pricing.json),取代硬编码 `$5/$25`;UI 标「估算」。各调用点(claude_proxy=claude、proxy_tokens=gemini/对应桶、codex=gpt)传入 family。
3. 趋势图用轻量内联 SVG/div(客户端无 recharts),与既有卡片风格一致。

## 定价单一源(packages/shared)
唯一源:**`packages/shared/src/pricing.json`** — 每家族 `{ inputPerM, outputPerM, cacheReadPerM }`(美元/百万 token)。起始值(实现时对照各厂商定价页核实,因只此一处、后续改价零成本):

```json
{
  "claude": { "inputPerM": 3,    "outputPerM": 15, "cacheReadPerM": 0.30 },
  "gemini": { "inputPerM": 1.25, "outputPerM": 10, "cacheReadPerM": 0.3125 },
  "gpt":    { "inputPerM": 1.25, "outputPerM": 10, "cacheReadPerM": 0.125 }
}
```
(claude 取 Sonnet 档作保守代表;派生比值即上面的 5/0.10、8/0.25、8/0.10。)

- **服务端(TS)**:`packages/shared` 导出 typed `PRICING` + 派生 `QUOTA_WEIGHTS`;api(已 `@gfa/shared: workspace:*`)从这里 import,替换 fair-share-tracker 里硬编码的 `QUOTA_WEIGHTS`。
- **客户端(Go)**:`scripts/sync-pricing.mjs` 把 `pricing.json` 拷到 `apps/bcai-wails/pricing.json`(已用 `go:embed` 模式),客户端 `//go:embed pricing.json` 读它算省钱。
- **防漂移**:sync 脚本挂到 predev/prebuild;CI 跑 `node scripts/sync-pricing.mjs && git diff --exit-code` —— 源改了没同步就红。

## 前端组件拆分(apps/web usage-stats)

- `ProviderSupplyOverview` — model 卡网格 + 状态甜甜圈 + sparkline(替换旧表)。
- `ModelDistributionChart` — 展开的直方图 + 水位档 chip 开关 + 点档下钻号列表。
- `BoundCardAccordion` — 账号折叠行 + 卡表 +「只看告警」开关(替换旧 AccountDetailCard 平铺)。
- 复用现有 KPI / UsageTrendCard。
- 甜甜圈 / 直方图 / sparkline 用纯 div+SVG,不引新图表库;趋势图沿用 recharts。

## 数据来源
- `/api/remote-stats`:供给 rollup(加 distribution)。
- `/api/remote-stats/dashboard`:账号水位 + 绑定卡 + 趋势 + 频率(绑定卡加 windowWeightedUsed)。
仍为 load + 手动刷新拉 dashboard(不进 30s 轮询);供给 rollup 进 30s 轮询。

## 实现约束
- **全程 TDD**:每个单元先写失败测试再实现(后端 vitest、客户端 go test、共享派生单测)。
- **web 端全部用 shadcn 组件**(Card/Badge/Button/Table/Collapsible/ToggleGroup/Chart 等);自定义可视化(甜甜圈/直方图/sparkline)用纯 div+SVG 包在 shadcn Card 里,不引新图表库,趋势图沿用现有 recharts(shadcn chart 封装)。
- **客户端尽量复用现有组件**:`apps/bcai-wails/frontend/src/components/ui/*`(Card/Button/Badge 等)与既有 `StatCard`/`UsageBar` 风格;趋势图作为新增小组件,但壳子用现有 Card。

## 测试
- 后端(api,vitest):`rollupProviderStats` distribution 各档边界计数;`QUOTA_WEIGHTS` 由 PRICING 正确派生(claude 5/0.10、gemini 8/0.25、gpt 8/0.10);`weightedCost` 用派生权重;dashboard 返回 windowWeightedUsed。
- 共享(packages/shared):pricing.json 解析 + 派生 ratio 单测。
- 客户端(Go,go test):`AddTokens(family,...)` 按家族算 SavedMoneyUSD(claude/gemini/gpt 各一例);embed 的 pricing.json 可解析。
- 一致性:`sync-pricing.mjs` 跑后 `git diff --exit-code` 干净(CI 守)。
- 前端 web:tsc 干净;直方图档开关后最大值重算;手风琴展开/折叠 +「只看告警」过滤;playwright 真实栈看一眼(登录 → usage-stats)。
- 前端客户端:tsc 干净;趋势图 daily/hourly 切换;省钱「估算」标签在位。

## 风险 / YAGNI
- 不做 Y 轴切加权用量(已砍)。
- 权重是相对代理(绝对预算仍由 429 学习),影响拼车"份额剩余"估算精度与展示,不动选号/计费真相。gpt 输出 3→8 会让 codex 拼车更重计输出(更贴真实成本),属预期。
- distribution 与直方图共用一份数据;甜甜圈与展开图同源,避免口径分叉。
- 单一定价源跨 TS/Go 无法共享代码,故用「一份 JSON + 构建拷贝 + CI 校验」而非两份常量;省钱是「估算」,家族单一价无法区分同家族不同档(Opus/Sonnet),可接受。
- 客户端改动需**发新版本**才生效(趋势图 + 新省钱价);服务端/web 改动即时。
