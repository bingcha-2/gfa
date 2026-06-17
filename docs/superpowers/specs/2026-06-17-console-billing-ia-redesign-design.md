# Console 计费域信息架构重设计:订单 / 套餐 / 账号 / 订阅 / 用量

日期:2026-06-17
状态:设计稿(待实现计划)

## 背景与问题

GFA 运营后台(console)里,计费域的五个实体——客户、订单(PlanOrder)、套餐目录(PlanCatalog)、订阅(Subscription)、上游账号/号池(Account)、用量(Usage)——在界面上是割裂的。具体痛点:

1. **订阅展示是骨架**:全局订阅页与客户详情页都只显示模式徽标(绑定/号池)+ 产品名,看不到每个产品绑在哪个上游号、什么等级、那号还剩多少份额。后端 `config`(含 `bindings`/`levels`/`line`)已返回,只是前端类型 `ConsoleSubscription` 没带、也没渲染。
2. **换绑割裂**:`RebindDialog` 只有一个产品下拉 + 一个账号 ID 输入,一次换一个产品,不显示当前绑定;一条订阅绑两个产品时表现为"只有一个框",运营盲操作。
3. **GRANT ¥0 订单的"退款"语义错**:管理员发放(`payChannel=GRANT`、`amountCents=0`、`status=PAID`)的订单,客户账单页因 `status==="PAID"` 也渲染出"退款"按钮,但后端 `refundOwnOrder` 直接拒(`"该订单无可退款金额"`)。管理端退款对 GRANT 单实际做的是"撤销授权"(跳过网关、标 REFUNDED、取消订阅、释放席位),叫"退款"误导。
4. **四者跳不动**:订单↔订阅↔账号↔用量之间没有聚合视图、没有互相跳转。运营在"某客户怎么了""这个号被谁占满了""这笔单激活了哪条订阅""这条跑量是谁"之间来回切页、对不上。

## 目标

把五个实体在 console 里**连起来**:多入口(客户 / 订单 / 号池 / 用量都能进),彼此能互相跳转。四条高频互跳路径(按优先级):

1. 号 → 占用它的订阅/客户
2. 客户 → 一屏全貌
3. 订单 → 订阅 → 号 → 用量
4. 用量异常 → 反查

非目标:不重写计费/租约后端逻辑;不新建中央"工作台";超卖只做轻量呈现(运营反馈超卖不严重)。

## 方案:订阅当枢纽 + 反查/跳转(方案 C)

订阅(Subscription)是五者的天然交汇点——属于某客户、由某订单激活、把每个产品绑到某个上游号、按它统计用量。因此:

- 做好一个**订阅详情枢纽**(所有入口都汇到它);
- 给现有页(客户 / 订单 / 号池 / 用量)**补字段 + 补跳转 + 改动作语义**。

不推翻现有 IA。核心新建只有「订阅详情枢纽」一块。

### 实体关系(真相源)

- 订阅座位/份额的真相源 = DB 中 `status=ACTIVE` 订阅的 `config.bindings`(非 access-keys.json 文件)。所有占用统计(`occupiedSharesByAccount` / `entitlement-sync.seatOccupancyFromDb` / `rosetta.occupiedSharesFromSubscriptions` / `billing.assertBindSeatsAvailable`)均只数 ACTIVE。
- 订阅取消(撤销/退款连带)= `status=CANCELLED` + `expireShadowRecord`;CANCELLED 不再被占用统计计入,**席位自动释放**(bindings 作历史保留)。
- 退款连带取消订阅:管理端 `cancelOrderSubscription` / 客户端 `cancelRefundedSubscription`。

## 设计分块

### 块 1:订阅详情枢纽(核心,新建)

一个订阅详情视图,四个入口都能打开。**形态:侧滑抽屉,但带可寻址 URL(如 `?sub=<id>` 或 `/console/subscriptions/<id>`)**,这样跳转链接可直达、可分享/刷新不丢。内容:

- **头部跨实体链接**:客户(→客户页)、来源订单(→订单)、来源徽标(管理员发放 / 付费渠道)。
- **概要**:模式(绑定线/号池线)、状态、有效期、共享(人话:"2 人拼车 · w4",非裸 weight)、设备数;号池线额外显示用量档。
- **产品与绑定表(逐产品一行)**:产品 | 等级 | 绑定上游号(`#id 账号名`,链到号页) | 该号份额(`已占/容量`) | 行内换绑按钮。未绑定的产品标红「绑号」。这一行同时解决"看得到绑定"和"换绑两产品只有一个框"。
- **用量**:本周/窗口余量条 + "看用量明细"链接。
- **动作**:撤销订阅(danger)。

### 块 2:换绑重做(并入块 1)

- 换绑从"单下拉 + 单输入的独立弹窗"改为**订阅详情里逐产品一行**,每行显示当前绑定号 + 目标号选择 + 确认。
- 复用现有 per-product 后端 `POST subscriptions/:id/rebind { product, accountId, force }`(无需改后端契约)。
- 选目标号时带份额上下文(避免换到已满的号);保留 `force`(跳过容量/停用校验)。
- 未绑定产品在此行直接"绑号"。

### 块 3:号池看板(复用 usage-stats + 补连接)

号池看板已存在 = `usage-stats` 页(KPI 横条、每家健康+模型供给水位、`BoundCardAccordion` 逐账号占用反查、每产品账号列表)。本次只做:

- **③ 逐账号占用表每行接跳转**:占它的每条订阅 → 订阅详情枢纽;客户邮箱 → 客户页。闭合"号→占用→订阅/客户"。
- **轻量超卖呈现**:看板加"只看超卖/吃紧"筛选 + KPI 显示"超卖 N 个号"。不做刺眼大告警。

数据来自现有 `/api/remote-stats/dashboard`(已含 `boundCards`:weight、fairShare、email、products、expiresAt 等)。

### 块 4:客户一屏全貌(增强客户详情页)

`customers/[id]` 聚合为一屏:

- **头部**:邮箱、状态、邮箱验证、注册/邀请关系、操作(发放订阅 / 编辑)。
- **KPI 横条**:生效订阅数、累计实付、历史订单、余额、本周最紧余量。
- **订阅面板**:每条订阅卡显示模式 + 绑定摘要(`Anthropic Max20x→#15 · Codex→⚠未绑定`),点卡进订阅详情;**已被取代/已取消的订阅明确标注**(解决"2 分钟连发两次"造成的困惑——已自动取消、不占座位)。
- **订单面板**:单号/套餐/金额/渠道/状态;**动作按渠道自适应**(GRANT=撤销授权,付费=退款;有用量则禁用并提示);单号/客户链接。
- **用量面板**:近 7 天 token、本周最紧、异常标记;→ 明细/反查。

### 块 5:订单链路 + 用量反查(给现有页补跳转)

- **订单页**:补"已激活订阅"列(→订阅详情);动作按渠道自适应(同块 4)。
- **用量页**:每行补反查链(订阅 / 客户 / 在跑的号);可按用量排序、异常标红。数据基本现成(BoundCardAccordion)。

## GRANT 退款语义(贯穿块 1/4/5)

- 按 `payChannel` 决定动作文案与行为:
  - `GRANT` → **撤销授权**(无退款金额;后端跳过网关、标 REFUNDED、取消订阅、释放席位)。
  - `ALIPAY/WXPAY` → **退款**(走网关)。
- 客户账单页:对 GRANT 单不再显示"退款"(后端本就会拒)。改为隐藏或显示非动作性的"管理员赠送"标记。
- 前置校验照旧:已 REFUNDED 幂等;支付后有用量则禁用并提示("已产生使用记录,不可退款")。

## 分期实现顺序

1. **块 1 + 块 2** 订阅详情枢纽 + 换绑重做(价值最高、四条路径都依赖它)。
2. **块 3** 号池看板接跳转 + 轻量超卖筛选(打通最高优先级"号→占用")。
3. **块 4** 客户一屏全貌。
4. **块 5** 订单链路 + 用量反查。
5. **GRANT 语义** 随块 1/4/5 落地;客户端账单页 GRANT 按钮修正可独立先行(小修)。

## 受影响文件(指引,非穷举)

前端(apps/web):
- `app/(console)/console/(dashboard)/(customer)/subscriptions/page.tsx`(订阅列表 + RebindDialog → 重做)
- `app/(console)/console/(dashboard)/(customer)/customers/[id]/page.tsx`(客户一屏全貌)
- `app/(console)/console/(dashboard)/(customer)/plan-orders/page.tsx`(订单链路 + 动作语义)
- `app/(console)/console/(dashboard)/(product)/usage-stats/BoundCardAccordion.tsx`(占用表接跳转 + 超卖筛选)
- 新增订阅详情枢纽组件(抽屉/页)
- `lib/console/types.ts`(`ConsoleSubscription` 补 `config`/`bindings`/`levels`/`line`)
- `components/account/account-billing-center.tsx`(客户端 GRANT 按钮修正)

后端(apps/server):
- `leasing/console/billing-admin/billing-admin.service.ts`(订阅列表已带 config;按需补份额/账号名加工)
- 复用 `subscriptions/:id/rebind`、`/api/remote-stats/dashboard`、`occupiedSharesFromSubscriptions`(无需改契约)

## 测试要点

- 订阅详情:绑定/号池两种模式渲染;未绑定产品标红;逐产品换绑成功/容量不足/force。
- GRANT 单动作:文案=撤销授权;执行后订单 REFUNDED + 订阅 CANCELLED + 席位释放(占用统计不再计入)。
- 跳转闭环:号→订阅→客户;订单→订阅→号/用量;用量→订阅/客户/号。
- 客户全貌:已取代订阅标注正确;订单动作按渠道自适应;有用量时退款禁用。
- 超卖筛选:`已占>容量` 的号被正确筛出与计数。
