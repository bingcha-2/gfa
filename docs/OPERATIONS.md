# Google Family Automation — 运营操作手册

> 版本：2026-03  
> 适用角色：ADMIN / OPERATIONS / SUPPORT

---

## 目录

1. [系统概览](#1-系统概览)
2. [登录控制台](#2-登录控制台)
3. [导入母号账号](#3-导入母号账号)
4. [绑定 AdsPower Profile（关键步骤）](#4-绑定-adspower-profile关键步骤)
5. [管理家庭组](#5-管理家庭组)
6. [兑换码与订单流程](#6-兑换码与订单流程)
7. [自动化任务管理](#7-自动化任务管理)
8. [人工干预流程](#8-人工干预流程)
9. [审计日志](#9-审计日志)
10. [常见问题排查](#10-常见问题排查)

---

## 1. 系统概览

```
用户兑换码
    ↓
API 分配家庭组空位
    ↓
Worker 自动发送 Google Family 邀请
（AdsPower + Playwright 驱动真实浏览器）
    ↓
用户接受邀请 → 订单完成
```

**核心组件：**

| 组件 | 地址 | 说明 |
|------|------|------|
| Web 控制台 | `http://localhost:3000/console` | 管理员操作界面 |
| 公开兑换页 | `http://localhost:3000/` | C 端用户自助兑换 |
| API 服务 | `http://localhost:3001/api` | 内部业务接口 |
| Worker | 后台进程 | 执行 AdsPower 自动化 |

---

## 2. 登录控制台

访问 `http://localhost:3000/console/login`

**初始账号（首次使用后请立即修改密码）：**

| 邮箱 | 密码 | 权限 |
|------|------|------|
| `admin@gfa.local` | `admin123` | ADMIN — 全部操作 |
| `support@gfa.local` | `admin123` | SUPPORT — 只读 + 人工完成/失败任务 |

> ⚠️ 这两个账号是由 `pnpm db:seed` 自动创建的固定初始账号。生产上线前必须修改密码。

---

## 3. 导入母号账号

### 3.1 支持的导入格式

批量导入支持两种文本格式，**每行一个账号**：

**格式 A（四短横线 `----`）**
```
loginEmail----password----recoveryEmail----totpSecret
```
示例：
```
mama01@gmail.com----MyPass123----recovery@gmail.com----JBSWY3DPEHPK3PXP
mama02@gmail.com----AnotherPwd----
```
- 字段 3（recoveryEmail）、字段 4（totpSecret）可留空
- 最少需要 2 个字段（邮箱 + 密码）

**格式 B（全角破折号 `——`）**
```
loginEmail——password——totpSecret
```
示例：
```
mama03@gmail.com——Secret456——JBSWY3DPEHPK3PXP
mama04@gmail.com——Secret789
```

> 两种格式可在同一次导入中混用，系统按行自动识别。

### 3.2 导入步骤

1. 登录控制台 → **账号管理** → 点击「批量导入」
2. 将账号文本粘贴到输入框（每行一个账号）
3. 点击「导入」
4. 查看导入结果：
   - `created`：成功新增条数
   - `skipped`：已存在（按邮箱去重），跳过
   - `errors`：格式错误的行，附带行号和原因

### 3.3 ⚠️ 重要限制：导入后无法立即自动化

**批量导入后，系统会为每个账号生成一个 `pending-{UUID}` 占位符作为 AdsPower Profile ID。**

```
adspowerProfileId: "pending-f47ac10b-58cc-4372-a567-0e02b2c3d479"
```

**Worker 在执行任务时，需要用真实的 AdsPower Profile ID 打开浏览器。使用占位符 ID，Worker 会报错并无法完成自动化任务。**

**导入后必须完成第 4 步（绑定真实 Profile），账号才能正常工作。**

---

## 4. 绑定 AdsPower Profile（关键步骤）

导入账号后，必须为每个账号创建或关联真实的 AdsPower 浏览器 Profile，并将 Profile ID 更新到系统。

### 4.1 在 AdsPower 中创建 Profile

1. 打开 AdsPower 客户端
2. 点击「新建环境」
3. 配置 Profile：
   - 名称建议与账号邮箱一致，方便对应
   - 指纹配置按需设置（操作系统、分辨率等）
4. 保存后，找到该 Profile 的 ID（在 AdsPower 列表中显示，格式如 `jdkap5v`）

### 4.2 将 Profile ID 更新到系统

**方式 A：控制台界面编辑**

1. 控制台 → **账号管理** → 找到该账号 → 点击「编辑」
2. 在「AdsPower Profile ID」字段中填入真实 ID（例如 `jdkap5v`）
3. 保存

**方式 B：API 直接更新（批量操作时效率更高）**

```bash
PATCH /api/accounts/{accountId}
Content-Type: application/json
Authorization: Bearer <your_jwt_token>

{
  "adspowerProfileId": "jdkap5v"
}
```

### 4.3 验证 Profile 绑定是否正确

绑定后，账号状态中 `adspowerProfileId` 字段不再以 `pending-` 开头即为成功。

可以通过控制台「任务」→「新建健康检查任务」（若有此功能）或直接观察下次 Worker 任务执行情况来验证。

### 4.4 Profile 无法自动化的降级机制

当 Worker 检测到以下情况时，任务会进入 **`WAITING_MANUAL`（等待人工确认）** 状态：

| 触发条件 | 说明 |
|----------|------|
| Google 要求手机推送验证 | Worker 无法接收推送，自动降级 |
| Google 要求短信验证码 | Worker 无法获取短信，自动降级 |
| 2FA 验证码（TOTP）不在系统中 | `totpSecret` 未配置 |
| AdsPower Profile 未启动/不可达 | Profile ID 错误或 AdsPower 未运行 |

降级后，需人工介入（见第 8 节）。

---

## 5. 管理家庭组

### 5.1 家庭组与账号的关系

- **1 个母号账号**可以拥有多个家庭组
- **1 个家庭组**最多 **5 个成员**（Google 限制）
- 批量导入时，系统会为每个账号自动创建 1 个默认家庭组（`maxMembers=5`）

### 5.2 查看家庭组状态

控制台 → **家庭组** → 查看列表

| 字段 | 说明 |
|------|------|
| `memberCount` | 当前成员数 |
| `availableSlots` | 剩余可邀请名额 |
| `status` | ACTIVE / FULL / SUSPENDED |
| `riskScore` | 风险评分（越低越安全） |

### 5.3 同步成员数据

当 Google 端实际成员与系统数据不一致时，手动触发同步：

**控制台操作：**  
家庭组详情 → 点击「同步」按钮

**API 操作：**
```
POST /api/family-groups/{groupId}/sync
```

Worker 会打开 AdsPower Profile，访问 Google Family 管理页，拉取实际成员列表并更新数据库。

### 5.4 手动移除成员

家庭组详情 → 找到成员行 → 点击「移除」→ 输入成员邮箱确认

Worker 会自动进入 Google Family 页面，找到该成员并执行移除操作。

> ⚠️ 移除操作不可逆，且会消耗该成员的 Google One 订阅权益。请谨慎操作。

---

## 6. 兑换码与订单流程

### 6.1 兑换码生命周期

```
生成兑换码（ADMIN 操作）
    ↓
用户访问 /redeem 页面，输入兑换码 + 自己的 Gmail
    ↓
系统自动分配家庭组（选择有空位的组）
    ↓
Worker 发送 Google Family 邀请
    ↓
用户接受邀请 → 订单状态变为 COMPLETED
```

### 6.2 公开兑换 API（无需登录）

用户可通过兑换页面自助兑换：

- **自助兑换页**：`http://localhost:3000/redeem`
- **查询订单**：`http://localhost:3000/status?code=<兑换码>`

### 6.3 查询订单状态

控制台 → **订单管理** → 按状态/邮箱筛选

| 状态 | 说明 |
|------|------|
| `PENDING` | 等待 Worker 处理 |
| `INVITE_SENT` | 邀请已发送，等待用户接受 |
| `COMPLETED` | 用户已接受，完成 |
| `FAILED` | 失败（已用完重试次数） |
| `WAITING_MANUAL` | 需人工干预 |

### 6.4 替换订单成员（换号操作）

当原成员邮箱需要更换时：

```
POST /api/orders/{orderId}/replace-member
{
  "targetMemberEmail": "old@gmail.com",
  "newUserEmail": "new@gmail.com",
  "reason": "用户申请换号"
}
```

Worker 会自动先移除旧成员，再向新邮箱发送邀请。

---

## 7. 自动化任务管理

### 7.1 任务类型说明

| 任务类型 | 触发时机 | 操作 |
|----------|----------|------|
| `INVITE_MEMBER` | 用户兑换 | 发送 Google Family 邀请 |
| `REMOVE_MEMBER` | 手动移除 | 从 Google Family 移除成员 |
| `SYNC_MEMBERS` | 手动触发 | 同步家庭组成员数据 |
| `REPLACE_MEMBER` | 换号操作 | 移除旧 + 邀请新 |

### 7.2 任务执行机制

1. **Worker 接到任务** → 获取账号的 AdsPower Profile ID
2. **Profile 加锁**（防止同一 Profile 被多个 Worker 同时操作）
3. **启动 AdsPower 浏览器 Profile**
4. **通过 CDP 连接浏览器**
5. **导航到 Google Family 管理页面**
6. **执行操作**（邀请/移除等）
7. **截图留存**（before/after，失败时有 error 截图）
8. **释放锁，关闭 Profile**

### 7.3 自动重试逻辑

Worker 使用 BullMQ 排队，任务失败后会自动重试：

- 可重试失败（`FAILED_RETRYABLE`）：Profile 被锁、网络超时、页面元素未找到等 → BullMQ 自动重试
- 最终失败（`FAILED_FINAL`）：账号不存在、Profile ID 无效 → 不再重试，需人工处理

### 7.4 查看任务详情

控制台 → **任务中心** → 点击具体任务

任务详情包含：
- 执行日志（时间线）
- 截图预览（before / after / error）
- 当前状态和错误原因

---

## 8. 人工干预流程

### 8.1 何时需要人工干预

以下情况会进入 `WAITING_MANUAL` 状态：

- Google 触发了**手机推送验证**（无法自动处理）
- Google 要求**短信验证码**
- AdsPower Profile 需要**重新登录 Gmail**
- 账号被 Google 临时锁定（风控）

### 8.2 人工完成任务

当运营人员手动完成了相应操作（如在浏览器中手动完成邀请）后：

**控制台操作：**  
任务中心 → 选择任务 → 点击「标记为完成」→ 填写备注（可选）

**API 操作：**
```
POST /api/tasks/{taskId}/manual-complete
{
  "resultMessage": "已手动完成邀请，用户已接受"
}
```

**权限要求：** ADMIN / OPERATIONS / SUPPORT 均可操作

### 8.3 人工标记任务失败

当任务确认无法完成时（如账号被封、用户邮箱错误）：

**控制台操作：**  
任务中心 → 选择任务 → 点击「标记为失败」→ 填写原因

**API 操作：**
```
POST /api/tasks/{taskId}/manual-fail
{
  "reason": "母号已被 Google 封禁，无法发送邀请"
}
```

### 8.4 重试失败任务

对于状态为 `FAILED_RETRYABLE` 的任务，可手动触发重试：

**控制台操作：**  
任务中心 → 选择任务 → 点击「重试」

**API 操作：**
```
POST /api/tasks/{taskId}/retry
```

> 重试前请确认根本原因已解决（如 AdsPower 已启动、Profile 已绑定）。

---

## 9. 审计日志

系统对所有重要操作自动记录审计日志，包括：

| 事件 | 说明 |
|------|------|
| `CREATE_ACCOUNT` | 创建账号 |
| `BULK_IMPORT_ACCOUNTS` | 批量导入 |
| `UPDATE_ACCOUNT` | 修改账号（密码变更只记录布尔值，不记录实际密码） |
| `DELETE_ACCOUNT` | 删除账号 |
| `CREATE_FAMILY_GROUP` | 创建家庭组 |
| `REMOVE_MEMBER` | 移除成员 |
| `TRIGGER_SYNC` | 触发同步 |
| `REPLACE_MEMBER` | 换号 |
| `RETRY_TASK` | 重试任务 |
| `MANUAL_COMPLETE_TASK` | 人工完成 |
| `MANUAL_FAIL_TASK` | 人工失败 |

> 敏感字段（`loginPassword`、`totpSecret`）不会写入审计日志。

---

## 10. 常见问题排查

### Q1: Worker 报错 `Profile locked`

**原因：** 同一 Profile 正在被另一个 Worker 执行任务，Redis 锁未释放。

**处理：**
1. 等待约 5 分钟（锁会自动过期）
2. 若长时间未解除，检查 Worker 日志确认是否有 Worker 崩溃
3. 手动重试任务

---

### Q2: Worker 报错 `AdsPower API unreachable`

**原因：** AdsPower 客户端未启动，或 API 端口（默认 50325）不可达。

**处理：**
1. 确认 AdsPower 桌面客户端已启动
2. 检查 `.env` 中 `ADSPOWER_HOST` 是否正确（默认 `http://127.0.0.1:50325`）
3. 在 AdsPower 设置中确认「本地 API」已开启

---

### Q3: 任务失败，截图显示 Google 登录页

**原因：** AdsPower Profile 的 Gmail 登录态已过期，需要重新登录。

**处理：**
1. 在 AdsPower 中手动打开该 Profile
2. 登录目标 Gmail 账号（可能需要输入 2FA）
3. 登录成功后关闭 Profile
4. 在控制台重试该任务

---

### Q4: 批量导入后，账号无法执行任务

**原因：** 批量导入时生成的是 `pending-{UUID}` 占位符 Profile ID，Worker 无法使用。

**处理：** 参考第 4 节，为每个账号在 AdsPower 创建真实 Profile 并绑定。

---

### Q5: 任务长期停留在 `PENDING` 状态

**可能原因：**
- Worker 进程未启动
- Redis 连接断开，队列无法消费

**处理：**
1. 检查 Worker 进程是否运行（`Status-GFA.bat` 或 `pnpm dev:worker`）
2. 检查 Redis 是否在线：`redis-cli ping`
3. 重启服务后，任务会自动被消费

---

### Q6: 任务持续报 `FAILED_RETRYABLE`，超过重试上限

**处理：**
1. 查看任务的 `errorScreenshotPath` 截图，分析具体失败原因
2. 修复根本原因（Profile 问题、账号状态等）
3. 人工标记失败，重新下单或联系用户

---

## 附录：账号状态说明

| 状态 | 含义 |
|------|------|
| `ACTIVE` | 正常可用 |
| `SUSPENDED` | 已暂停，不会接受新任务 |
| `BANNED` | 已封禁（Google 风控），需更换账号 |

## 附录：角色权限矩阵

| 操作 | ADMIN | OPERATIONS | SUPPORT |
|------|:-----:|:----------:|:-------:|
| 导入/创建账号 | ✅ | ❌ | ❌ |
| 修改/删除账号 | ✅ | ❌ | ❌ |
| 创建家庭组 | ✅ | ❌ | ❌ |
| 移除成员 | ✅ | ✅ | ❌ |
| 触发同步 | ✅ | ✅ | ❌ |
| 替换成员 | ✅ | ✅ | ❌ |
| 重试任务 | ✅ | ✅ | ❌ |
| 人工完成/失败任务 | ✅ | ✅ | ✅ |
| 查看订单/任务 | ✅ | ✅ | ✅ |
| 查看审计日志 | ✅ | ✅ | ✅ |
