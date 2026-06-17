# Customer Subscription Expiry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 后台客户详情页可发放自定义有效期订阅，并可编辑已有订阅到期时间。

**Architecture:** 手动发放将有效期天数作为 admin-only override 传入订阅激活入口，不影响普通购买。已有订阅到期时间通过 billing-admin 订阅更新接口修改，并立即同步 entitlement shadow record。

**Tech Stack:** NestJS, Prisma, Vitest, Next.js, React, shadcn/ui.

---

### Task 1: 后端发放有效期 override

**Files:**
- Modify: `apps/server/src/leasing/console/customer-admin/dto/customer-admin.dto.ts`
- Modify: `apps/server/src/leasing/console/customer-admin/customer-admin.service.ts`
- Modify: `apps/server/src/leasing/console/customer-admin/customer-admin.controller.ts`
- Modify: `apps/server/src/leasing/subscription/subscription.service.ts`
- Test: `apps/server/src/leasing/console/customer-admin/__tests__/customer-admin.service.spec.ts`
- Test: `apps/server/src/leasing/subscription/__tests__/subscription.service.spec.ts`

- [ ] 写失败测试：`grantCatalogSubscription` 将 `durationDays` 传给 `activateForOrder`。
- [ ] 写失败测试：`SubscriptionService.activateForOrder(order, { durationDaysOverride: 7 })` 创建或续期时使用 7 天。
- [ ] 实现 DTO 校验、service 参数、controller 审计和订阅服务 override。
- [ ] 运行相关测试。

### Task 2: 后端编辑订阅到期时间

**Files:**
- Modify: `apps/server/src/leasing/console/billing-admin/billing-admin.service.ts`
- Modify: `apps/server/src/leasing/console/billing-admin/billing-admin.controller.ts`
- Test: `apps/server/src/leasing/console/billing-admin/__tests__/billing-admin.service.spec.ts`
- Test: `apps/server/src/leasing/console/billing-admin/__tests__/billing-admin.controller.spec.ts`

- [ ] 写失败测试：更新 `expiresAt` 后 DB 和 `syncSubscription` 都收到新时间。
- [ ] 写失败测试：controller 调用 service 并记录 audit。
- [ ] 实现 `PATCH console/subscriptions/:id`。
- [ ] 运行相关测试。

### Task 3: 前端客户详情页

**Files:**
- Modify: `apps/web/src/app/(console)/console/(dashboard)/(customer)/customers/[id]/grant-subscription-dialog.tsx`
- Modify: `apps/web/src/app/(console)/console/(dashboard)/(customer)/customers/[id]/page.tsx`

- [ ] 发放弹窗新增有效期天数输入，打开时按 catalog 默认值初始化。
- [ ] 提交发放时携带 `durationDays`。
- [ ] 订阅表新增编辑按钮和到期时间弹窗。
- [ ] 保存时调用 `PATCH subscriptions/:id` 并刷新详情。

### Task 4: 验证

**Files:**
- Read: `package.json`
- Read: `apps/server/package.json`
- Read: `apps/web/package.json`

- [ ] 运行后端 targeted Vitest。
- [ ] 运行前端 lint/typecheck 或可用的 targeted check。
- [ ] 检查 `git diff`，确认没有触碰无关 Wails 生成文件。

