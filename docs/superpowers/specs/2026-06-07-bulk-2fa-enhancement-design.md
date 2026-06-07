# 批量 2FA 录入格式完善与 Google 登录多页面兼容设计说明书

本项目旨在优化 GFA 系统中的批量更新 2FA (TOTP) 功能，主要解决用户录入账号格式错乱导致 TOTP 解析失败、Google 登录时无法自动通过“辅助邮箱验证”页面以及遇到验证码/短信挑战时浏览器立即关闭的问题。

## 1. 需求背景与问题分析

### 1.1 格式解析问题
在原设计中，`bulk-2fa.service.ts` 采用固定索引进行切分：
- `parts[2]` 强制映射为 `oldSecret`
- `parts[3]` 强制映射为 `recoveryEmail`

当用户录入的格式中辅助邮箱与 2FA 密钥顺序相反，或者包含空格、特殊格式（如 `2fa.live` 的 URL 链接）时，解析器会将包含 `@` 或 `.` 的辅助邮箱/URL 错当成 TOTP 密钥。这会导致 TOTP 密钥包含非法 Base32 字符，产生验证错误。

另外，如果用户复制的数据在录入时带有换行，原解析器将无法把换行的数据自动归并到同一行账号中。

### 1.2 Google 登录兼容问题
原 `gmail-login.ts` 的自动登录逻辑未涵盖以下场景：
- **选择验证方式界面**：未能在没有 TOTP 选项时或优先自动选择“确认您的辅助邮箱（Confirm your recovery email）”验证。
- **确认辅助邮箱挑战界面**：当 Google 弹出“确认您添加的辅助邮箱”输入框时，无法自动填写并提交该邮箱。
- **临时人机验证 (CAPTCHA) 或手机短信验证**：批量 2FA 脚本没有传递 `manualChallengeWaitMs`，导致遇到验证码时直接报错退出，用户无法手动处理。

---

## 2. 方案设计

### 2.1 批量解析器优化 (`bulk-2fa.service.ts`)
我们引入与核心账号导入（`account.service.ts`）相同的智能归类逻辑：
1. **智能切分与多行支持**：
   - 识别行开始：若一行包含分隔符（如 `----`、`,`、`|`、`\t`），且第一列包含 `@`（代表邮箱），第二列不为空（代表密码），则创建新的账号项。
   - 处理延续行：若当前行不符合新账号的开始特征，则将其整行（或切分后的部分）追加到上一个解析账号的 `extra` 字段列表中。
2. **多字段智能识别**：
   - 包含 `@` 的字段：归类为 `recoveryEmail`（辅助邮箱）。
   - 不含 `@` 的字段：使用正则提取 `2fa.live` 中的 Token 或清洗 Base32 字符后，归类为 `oldSecret`（旧 TOTP 密钥）。

### 2.2 Google 自动登录增强 (`gmail-login.ts`)
1. **参数定义**：
   - 更新 `LoginCredentials` 接口，加入可选的 `recoveryEmail?: string | null` 属性。
2. **多页面流程适配**：
   - **在 `handleChallengeSelection` 中**：如果无法选取 TOTP 选项，但设置了 `recoveryEmail`，则查找并点击文本包含 “Confirm your recovery email”（或中文“确认您的辅助邮箱/備用電子郵件”）的选项。
   - **在 `gmailLogin` 的 Round 循环中**：增加对辅助邮箱确认框的检测。定位 `input[name="knowledgePrereqValue"]` 或 `input[id="knowledgePrereqValue"]`，填入 `credentials.recoveryEmail` 并调用 `clickNext` 提交。
3. **增加人工干预等待**：
   - 在 `bulk-2fa.processor.ts` 中调用 `gmailLogin` 时，传入配置 `{ manualChallengeWaitMs: 300000 }`（5分钟）。
   - 当遇到 CAPTCHA 或 Phone 验证时，脚本会自动在此阻塞，保留 AdsPower 浏览器，方便管理员在 5 分钟内手动点击或填写手机验证码，一旦通过，流程将继续自动执行。

---

## 3. 影响范围与兼容性说明
- 本次改动仅限内存和本地 JSON 数据流（文件存储在 `data/bulk-2fa/job_<id>.json` 中），**不修改数据库 schema**，不会产生升级兼容性风险。
- `gmail-login.ts` 作为公共模块被多个处理器（Sync、Invite、Replace、Remove 等）引用，新增 `recoveryEmail` 为可选字段，完全向下兼容。

---

## 4. 验证方案

### 4.1 自动化解析单元测试
编写/运行单元测试，确保：
- `ParaaMarie647@gmail.com----ycbzttayda----`
  `ParaaMarie64718143@westt.site----`
  `https://2fa.live/tok/uekama7nd3ekdhiq4fohugdbgw3ym6th`
  可以被正确合并解析为：邮箱 = `ParaaMarie647@gmail.com`，密码 = `ycbzttayda`，辅助邮箱 = `ParaaMarie64718143@westt.site`，TOTP = `UEKAMA7ND3EKDHIQ4FOHUGDBGW3YM6TH`。

### 4.2 手动功能测试
- 在后台录入测试账号，启动 2FA 修改任务。
- 确认在遇到辅助邮箱验证时，脚本能自动填入并成功进到下一步。
- 确认当触发滑块人机验证时，脚本日志显示正在等待，并且手动滑过之后，任务能继续进行并成功完成 2FA 修改。
