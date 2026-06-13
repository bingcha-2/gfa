# 账户自助退款(用户订单页)设计

- 日期:2026-06-14
- 状态:待用户评审 → 实现

## 目标

用户在「账户 → 账单/订单」页,对自己**已支付且未使用**的订单**自助即时退款**:退回实付的 **96.4%**(扣 3.6% 渠道费,与支付页 `channelFeeNote` 提示一致),成功后**自动取消对应订阅**。

## 背景 / 可复用资产

- `BillingService.refundEpayOrder(outTradeNo, amountCents)`:已实现的 epay(zhunfu)退款引擎——两步(`/api/pay/refund` 发起 → `/api/pay/refundquery` 复核 `status=1`),`out_refund_no = rf${outTradeNo}` 确定性幂等,**支持部分退款**(`money` 按传入金额)。
- `BillingAdminService.refundOrder(orderId)`(console 管理员):完整流程——状态校验、**支付后用量护栏**(`cardTokenUsage` 自 `paidAt` 起 > 0 即拒)、`GRANT`/¥0 跳网关、先退钱后 CAS `PAID→REFUNDED`、取消订阅、发通知。**用户路径镜像它**,仅多一道归属校验、金额改 96.4%。
- `PlanOrder` 字段齐全:`customerId`(归属)、`payChannel`、`amountCents`、`outTradeNo`、`paidAt`、`status`。
- 账户订单 UI:`apps/web/src/components/account/account-billing-center.tsx`(`SyncOrderButton` / `CancelOrderButton` 可参照)。

## 决策(已确认)

1. **流程**:用户自助即时退款(非人工审核)。
2. **金额**:退 `round(amountCents × 0.964)`,保留 3.6% 渠道费。管理员退款仍全额(裁量),两条路互不影响。
3. **资格**:`PAID` + 属于本人 + 自 `paidAt` 起无 token 用量 + 真实付费单(`payChannel ≠ GRANT` 且 `amountCents > 0`)。**不加额外时间窗**——用量护栏已足够。
4. **按钮显示**:所有 `PAID` 订单都显示「退款」按钮;点击时服务端校验,已用则返回明确错误「已使用,不可退款」(免去列表逐单查用量)。

## 后端

新增端点(挨着现有 `cancel`):

```
POST /api/account/billing/orders/:outTradeNo/refund
  → BillingController 取当前 customer.customerId
  → BillingService.refundOwnOrder(customerId, outTradeNo)
```

`refundOwnOrder(customerId, outTradeNo)` 步骤:

1. 按 `outTradeNo` 查订单;不存在 → 404;`order.customerId !== customerId` → 403(归属)。
2. `status === "REFUNDED"` → 幂等返回 `{ ok:true, alreadyRefunded:true }`。
3. `status !== "PAID"` → 409「只有已支付订单可退款」。
4. `payChannel === "GRANT" || amountCents <= 0` → 409「该订单无可退款金额」。
5. 用量护栏:`cardTokenUsage.count({ customerId, timestamp >= (paidAt ?? createdAt) }) > 0` → 409「已使用,不可退款」。
6. `refundCents = Math.round(amountCents * 0.964)`;调 `refundEpayOrder(outTradeNo, refundCents)`;`!ok` → 503,订单保持 `PAID`(可重试)。
7. 网关确认成功 → CAS `updateMany({ id, status:"PAID" }, { status:"REFUNDED" })`;`count ≠ 1` → 重读,`REFUNDED` 则幂等返回,否则 409。
8. 取消对应订阅 + 发通知(复用管理员同等逻辑)。
9. 返回 `{ ok:true, refundedCents: refundCents }`。

**复用策略**:把管理员 `refundOrder` 与用户 `refundOwnOrder` 的公共尾段(用量护栏、退款、CAS、取消订阅、通知)抽成共享内部方法 `executeRefund(order, { refundCents })`,两边各加前置校验(管理员:无归属、全额;用户:归属、96.4%)。单点维护、减重复。

## 前端

- `account-billing-center.tsx`:对 `PAID` 行加 `RefundOrderButton`(仿 `CancelOrderButton`),点击弹确认框。
- 确认框:展示退款钱数(96.4%)、3.6% 渠道费不退、订阅将被取消、仅未使用可退;确认后调端点,成功 toast + 刷新列表,失败显示服务端文案(如「已使用,不可退款」)。
- `user-api.ts` 加 `refundOrder(outTradeNo)`。
- i18n:按钮 / 确认框 / 成功 / 失败文案,9 语言(zh-CN 源 + 同步 8 语言),挂 `portalApp.billing`。

## 边界 / 安全

- **幂等**:订单状态 CAS + 确定性 `out_refund_no`,并发点击/重试收敛为一次。用户 96.4% 与管理员全额共用 `rf${outTradeNo}`,但「每单仅一次 PAID→REFUNDED」保证不会撞金额。
- **钱→状态顺序**:网关 `status=1` 确认后才翻 `REFUNDED`;失败保持 `PAID`。
- **已知小非原子点**(沿用管理员现状):CAS 与取消订阅两次写;CAS 成功后取消订阅抛错 → 订单已 `REFUNDED` 但订阅残留,重试返回 `alreadyRefunded` 不再取消 → 运营手动撤订阅兜底。本次不扩大处理。

## 测试

`refundOwnOrder` 单测:他人单 → 403;非 `PAID` → 409;`GRANT`/¥0 → 409;有用量 → 409;正常退(断言传给 `refundEpayOrder` 的金额 = 96.4%);网关失败保持 `PAID`;幂等(`REFUNDED` 再退);退款连带取消订阅。

## 上线注意

⚠️ 本功能改 `billing.controller.ts` / `billing.service.ts`,与另一会话正在进行的 billing/epay 改动可能冲突——实现时挑其空闲、或先并入对方改动;新逻辑尽量集中在新增方法以缩小触碰面。
