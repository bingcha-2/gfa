# 客户订阅有效期管理设计

## 目标

后台客户账户详情页支持运营调整订阅时间：手动发放订阅时可指定有效期天数，已有订阅可直接修改到期时间。

## 范围

- 发放订阅弹窗新增“有效期天数”，默认使用当前套餐目录的 `durationDays`。
- 后端手动发放接口接收 `durationDays`，订阅激活时按该天数计算 `expiresAt`；同配置续期也按该天数延长。
- 客户详情页订阅列表新增“编辑”操作，可修改订阅 `expiresAt`。
- 后端新增后台订阅更新接口，修改 `expiresAt` 后同步 entitlement shadow record。

## 非目标

- 不支持换套餐、换产品、换席位、改绑定账号。
- 不调整用户购买页和真实支付订单有效期，普通购买仍使用套餐目录 `durationDays`。

## 数据流

1. 运营在客户详情页打开“发放订阅”。
2. 前端读取 `/api/plan-catalog` 后初始化有效期天数。
3. 提交 `POST /api/console/customers/:id/subscriptions`，body 为 `{ selection, durationDays }`。
4. `CustomerAdminService` 创建 GRANT 订单，再调用 `SubscriptionService.activateForOrder(order, { durationDaysOverride })`。
5. `SubscriptionService` 对新订阅或同配置续期统一使用 override 计算到期时间，并正常执行 entitlement sync。
6. 运营编辑已有订阅时提交 `PATCH /api/console/subscriptions/:id`，body 为 `{ expiresAt }`。
7. `BillingAdminService` 更新订阅并调用 `EntitlementSyncService.syncSubscription`，保持 runtime key 到期时间一致。

## 校验

- `durationDays` 必须是 1 到 3650 的整数。
- `expiresAt` 必须是合法 ISO 日期字符串；暂不支持设置为 `null`。
- 不存在的客户或订阅返回 404。

