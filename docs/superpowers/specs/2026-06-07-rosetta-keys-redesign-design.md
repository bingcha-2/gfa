# 卡密管理页重设计 — 设计文档(方案 A)

日期:2026-06-07
范围:`apps/web/src/app/console/(dashboard)/rosetta-keys/`(前端为主)+ `apps/api`(少量接口扩展)
背景:配额已按方案 B 重构(每卡封顶=bucketLimits 按模型;绑定卡另有 fair-share 份额)。现有页面表单太挤、列表 12 列横向滚动、卡类型无区分、配额模型在列表里看不到 —— 本次重设计页面与交互,不改配额内核语义。

## 1. 目标与决策(已确认)

- **主用途**:创建为主;两类卡(万能/绑定)都不少,需平等支持。
- **列表一眼看到**:卡类型、额度用量/剩余、状态&到期。异常/客户端ID/最后使用降级。
- **方案 A**:顶部「+ 生成卡密」→ 向导弹窗;下方精简表格回归监控。
- **卡类型模型**:
  - **万能卡 = 不绑任何产品 → 自动开放全部产品**,唯一控量手段是「模型限额」(每模型 token 上限;留空=无限;一个都不设=无封顶,需警示)。**不做"可用产品"限制**。
  - **绑定卡 = 逐产品绑号**(每产品选账号+等级),靠「份额(weight)」均分账号原生配额;可再叠加「模型限额」作为绝对封顶。
  - 切换:卡类型是**显式状态开关(万能/绑定)**,不由"是否绑了账号"隐式推导。选「万能」即清空 bindings({});选「绑定」再逐产品绑号。后端 `setAccessKeyBindings` 接受整张 `{product:accountId}` 映射({} = 万能),已支持换绑/解绑/增开/切池。
- **额度只按模型**,不做整卡总额度。

## 2. 页面布局(静息态)

- **工具栏**:搜索框 · 类型筛选(全部/万能/绑定)· 状态筛选(全部/active/禁用/过期)· 排序 · 概览 chips(共/活跃/7天内到期/已停过期)· 「清理 ▾」菜单(清理过期 / 清理未绑定)· 右侧「+ 生成卡密」主按钮。
- **精简表格 5 列**:`卡密/备注` · `类型` · `状态·到期` · `额度` · `操作`。
  - 卡密单元:`code` + 复制图标 + 备注副行。
  - 类型:徽章(`万能` 蓝 / `绑定·<产品>` 紫);绑定卡副行只读显示绑到的账号(email/id)。
  - 状态·到期:status 点 + 剩余天数(<7d 黄,过期红)。
  - 额度(见 §4)。
  - 操作:`编辑` `用量` `启用/禁用`(直接切换) `删除`(二次确认)。
- **行展开(可选,点行/▸)**:收纳次要信息——各模型额度明细、用量(总/窗口/请求)、异常、客户端ID、最后使用。

## 3. 创建向导(弹窗 · 分步) 与 编辑面板(单页)

二者**共用配置组件 `card-config-form`**(基本 + 产品与绑定 + 模型限额)。

### card-config-form 区块
1. **基本**:名称/备注(可选)· 有效期(数值+单位)· 限流窗口(数值+单位,默认5h)。
2. **产品与绑定**:逐产品行(Codex / Antigravity / Anthropic):
   - 未绑定(默认)/ 绑定账号(选账号=换绑)+ 会员等级。
   - 「份额(几人共享,1–8)」(作用于本卡所有绑定)。
   - 顶部是**显式「卡类型」切换(万能 / 绑定)**。选万能 → 隐藏逐产品绑定区(显示"全产品开放,靠模型限额控量"说明)、清空 bindings;选绑定 → 显示逐产品绑定行。可用模型桶随卡类型变(万能=全产品桶;绑定=已绑产品桶)。
   - 选号下拉复用 rosetta-accounts(显示 `usedShares/shareCapacity`,份额不足禁选)。
3. **模型限额**:列出"当前可用模型"的每窗口 token 上限(留空=无限),每行带"已用"参考,支持「一键全部设为 X」。
   - 万能卡:列全部模型桶(antigravity-claude / antigravity-gemini / codex-gpt / anthropic-claude)。
   - 绑定卡:仅列已绑定产品对应的桶。

### 新增向导(create-wizard)
步骤:① 选类型(万能/绑定两张大卡)→ ② 配置(= card-config-form;万能只显示基本+模型限额,绑定显示全部)→ ③ 生成数量 + 生成。
- 模型限额可在步骤里设,也可「跳过,稍后在编辑里设」。
- 生成后**结果面板**:列出全部卡密(等宽字体)+「全部复制」。

### 编辑面板(card-edit-dialog)
单页分区(全字段可见,改起来顺)= card-config-form + **状态(启用/禁用)** 切换。类型可改:面板里**显式「卡类型」开关**(万能/绑定),切到万能保存即清空绑定。
- 保存 = `updateAccessKey`(名称/有效期/限流窗口/状态/weight/bucketLimits)+ `setAccessKeyBindings`(整张绑定映射)。
- **删除只在行内**(行操作的「删除」+ AlertDialog 二次确认),编辑面板内**不放删除**,避免重复。启停在行内和编辑内都可(行内快捷切换;编辑内作为状态字段)。

## 4. 额度可视化(§表格"额度"列)

- **万能卡**:逐模型进度条 `<模型> 已用/上限 ▮▮▯`(绿<80% / 黄80–100% / 红超额);未设上限的模型显示 `∞`;**一个都没设 → "无封顶"警示**(红框 chip)。
- **绑定卡**:`份额 1/4 人 · 公平额度 ▮▮▯ X%`;若设了模型封顶再加 `<模型> 已用/上限 ▮▮▯`。账号原生剩余血条**不进列表**(数据重),放「用量」弹窗显示。
- 列表只展示能从 `listAccessKeys` 拿到的数据(见 §6);明细(原生血条、逐事件)在「用量」弹窗。

## 5. 状态

- 载入:骨架/spinner;空态:Empty(区分"无卡"/"无匹配搜索");错误:toast + 重试。
- 生成/保存失败:弹窗保持打开 + 内联错误。
- 操作后 refetch 刷新;启停/删除乐观提示 + 失败回滚。

## 6. 数据 / 接口改动(apps/api)

1. **`listAccessKeys` 扩展每卡配额摘要**(给"额度"列):每卡追加
   - `cardType: 'pool' | 'bound'`(由 bindings 推导)
   - `buckets: { bucket: string; label: string; used: number; limit: number }[]`(limit=0 表示无限;复用 `getAccessKeyLimits` 的 buckets 计算 + `recentBucketUsage`)
   - 绑定卡:`bindingsDetail: { product: string; accountId: number; accountEmail?: string }[]`(accountId→email 需 join 账号文件)、`weight`、可选 `fairShare: { fraction: number }`(来自 FairShareTracker.getCardQuotaFractions,若易取)
   - 已有字段保留:`status/expiresAt/recentWindowTokens/bucketLimits/bindings` 等。
2. **`updateAccessKey` 增加 `weight`**(支持编辑改份额;clamp 1–8)。
3. **`setAccessKeyBindings`**:复用现状(整张映射)。
4. 万能卡"可用产品限制"(universal+products 数组):**不实现**(万能=全产品)。
5. **用量记录**:复用现有 card-usage 接口(`card-usage-dialog` 沿用),并在其中展示绑定卡的账号原生剩余(若该接口已有/可加)。
6. 选号下拉数据:复用 rosetta-accounts(含 usedShares/capacity)。

## 7. 文件结构(拆分现 1425 行 `page.tsx`)

```
rosetta-keys/
  page.tsx                      // 容器:取数/状态/布局编排(瘦身)
  use-access-keys.ts            // 列表取数 + 刷新 hook
  use-lease-accounts.ts         // 账号下拉数据 hook(选号/份额校验)
  toolbar.tsx                   // 搜索/类型·状态筛选/排序/概览chips/清理菜单/生成按钮
  key-table.tsx                 // 表格 + 行 + 行展开
  quota-cell.tsx                // 额度可视化(万能模型条 / 绑定份额)
  card-config-form.tsx          // ★共享:基本 + 产品与绑定 + 模型限额
  product-binding-manager.tsx   // 逐产品 绑定/换绑/解绑 + 份额
  model-limits-editor.tsx       // 逐模型 token 上限(+一键设全部)
  create-wizard.tsx             // 新增向导(选类型→config→数量→生成→结果)
  card-edit-dialog.tsx          // 编辑(单页 config + 状态切换 + 保存)
  card-usage-dialog.tsx         // 沿用(用量记录;补绑定卡原生剩余)
  types.ts                      // 卡/配额摘要/绑定 等前端类型(对齐 listAccessKeys)
```
- 旧 `card-limits-dialog.tsx` 逻辑并入 `model-limits-editor.tsx`,删除旧弹窗与其入口。
- 复用 shadcn:Dialog / Table / Tabs / Select / Badge / Tooltip / Checkbox / DropdownMenu / Progress / Command(账号搜索)/ AlertDialog / Empty / Skeleton。

## 8. 不在本次范围

- 不改配额内核(enforce/bucketLimits/fair-share 语义);不改客户端 Go;不做整卡总额度;不做万能卡产品限制;不引入新图表库。

## 9. 验收

- `apps/api` tsc 0 错、vitest 全过(含新增 listAccessKeys 配额摘要 + updateAccessKey weight 的测试)。
- `apps/web` tsc 0 错、`next build`(或 lint tsc)通过。
- 页面三类场景人工核对:万能卡(设/不设模型限额)、绑定卡(绑号+份额)、创建向导(两类)+ 编辑(切换类型/换绑/解绑/增开/改份额/删除)。
