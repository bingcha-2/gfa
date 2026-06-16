# GFA 与 CLIProxy 同步设计

## 目标

让 GFA 成为 Antigravity 账号健康状态、重新授权和 CLIProxy 同步的权威来源。这样账号遇到 `400 invalid_grant` 时，能在 GFA 后台看见、处理和恢复；同时 CLIProxy 在服务 `gemini-3.1-flash-image` 以及其它模型时，可以更健康地换号和降级失败。

## 背景

GFA 目前已经在 lease core 里维护账号健康状态。`/api/remote-token/status` 会暴露 `quotaStatus`、`quotaStatusReason`、`blockedUntil`、按模型封禁、活跃 lease、额度快照等信息。但 Antigravity 账号页目前更多展示静态字段和启用状态，并没有稳定展示 `invalid_grant` 这类运行时健康状态。

CLIProxy 现在接收 GFA 导出的 auth 文件，然后用自己的 auth 池执行请求。当 CLIProxy 遇到上游 `400 invalid_grant` 时，这个错误可能只停留在 CLIProxy 和 new-api 层。GFA 不一定知道导出的副本已经坏了，所以后台操作员无法可靠地看到或修复这个账号。

## 设计原则

GFA 是账号身份、健康状态、入池状态、refresh token 归属和重新授权的唯一真相源。

CLIProxy auth 文件只是 GFA 派生出来的执行副本。CLIProxy 可以把运行观察上报给 GFA，但不能独立把一个已被 GFA 判定不可用的账号恢复为可用。

同步必须能承受部分失败。实时回调用于快速反馈，定时对账用于修复漏报事件、远端手工修改、陈旧 auth 文件和短暂网络故障。

每一次同步变更都带一个单调递增的 `revision`。旧的 CLIProxy 事件不能把一个已经重新授权成功的新账号再次标成死号。

## 账号状态模型

在每个 Antigravity 账号记录上增加一个同步状态段：

```ts
type CliProxySyncState = {
  desired: "enabled" | "disabled" | "deleted";
  remoteProvider: "antigravity" | "gemini";
  remoteName: string;
  revision: number;
  tokenHash: string;
  lastSyncedAt: number;
  lastSeenAt: number;
  lastError: string;
};
```

`remoteName` 应包含 GFA 账号 id：

```text
antigravity-gfa-123-user@example.com.json
```

这样可以避免邮箱变化、重复邮箱、历史手工上传文件导致的匹配歧义。

GFA 上传给 CLIProxy 的凭证 JSON 顶层也应写入轻量同步身份字段：

```json
{
  "gfa_account_id": 123,
  "gfa_revision": 7
}
```

CLIProxy 读取 auth 文件时会把顶层字段保存在运行时 metadata 中。错误回传优先使用这些字段；如果老文件没有这些字段，再退回到 `remoteName` 中的 `gfa-<id>` 解析。这样可以让重新授权后的新 revision 和旧请求错误严格分开。

当 refresh token、project id、代理敏感的凭证内容、provider 类型或期望状态变化时，`revision` 递增。

`tokenHash` 是 refresh token 或凭证负载的非敏感哈希，只用于判断远端是否漂移。日志里不能输出原始 token。

## GFA 到 CLIProxy 同步

GFA 增加一个轻量同步服务，负责让 CLIProxy 的 auth 文件状态与 GFA 的期望状态一致。

同步触发条件：

- 新增账号，并且 token 探活成功。
- 账号重新授权成功。
- 账号被启用、禁用、删除或移出池。
- 账号被标记为 `quotaStatus=error` 且 `quotaStatusReason=invalid_grant`。
- project id 或 provider 类型变化。
- 操作员手动点击重新同步。
- 定时对账任务运行。

同步行为：

- `desired=enabled`：上传或覆盖远端 auth 文件，然后确认它出现在 CLIProxy 管理列表中。
- `desired=disabled`：如果 CLIProxy 支持禁用远端 auth，则调用禁用；否则根据管理 API 能力选择删除，或上传 `disabled=true` 的文件。
- `desired=deleted`：删除远端 auth 文件。
- 同步失败写入 `cliproxySync.lastError` 并显示在后台，但不能抹掉 GFA 的账号健康状态。

上传前，GFA 必须用生成 CLIProxy auth 时相同的 OAuth client 路径探活 refresh token。探活结果为 `invalid_grant` 的账号不能上传。

## CLIProxy 到 GFA 错误回传

CLIProxy 遇到账号级失败时，上报到新的 GFA 端点：

```json
{
  "provider": "antigravity",
  "gfaAccountId": 123,
  "remoteName": "antigravity-gfa-123-user@example.com.json",
  "revision": 7,
  "model": "gemini-3.1-flash-image",
  "status": 400,
  "reason": "invalid_grant",
  "requestId": "req_...",
  "at": 1781510400000
}
```

这个端点使用单独的共享密钥鉴权，和后台管理员 JWT、用户 access key 分开。

GFA 收到事件后校验：

- 账号 id 存在。
- `remoteName` 匹配该账号当前同步状态。
- `revision` 等于账号当前 revision。
- provider 符合账号期望 provider。

如果事件 revision 已过期，GFA 忽略它，并记录为 ignored telemetry。这样可以保护刚重新授权成功的账号不被旧请求重新打回死号。

错误分类：

- `400 invalid_grant`：将账号标记为 `quotaStatus=error`、`quotaStatusReason=invalid_grant`，清除运行时可用性，并加入 CLIProxy 禁用或删除同步队列。
- `429`：只封禁上报的模型或模型族，直到 reset 或 retry-after，不把整号判死。
- `503` 或 capacity 类原因：对该模型做短冷却。
- `401 token_invalidated`：清除缓存 access token，让下一次 GFA lease 强制刷新。
- 用户请求参数错误和 schema 错误：记录遥测，但不处罚账号。

## 重新授权流程

Antigravity 账号表每一行增加重新授权动作。

流程：

1. 操作员在账号 `#123` 上点击重新授权。
2. GFA 发起 Google OAuth，并在 pending session 中保存 `targetAccountId=123`。
3. 操作员打开授权 URL，完成授权后粘贴 callback URL。
4. GFA 用授权码换取新的 refresh token。
5. GFA 校验返回的 email 是否匹配目标账号 email。
6. 如果 email 匹配，GFA 更新当前账号；如果不匹配，API 返回需要确认的结果，而不是静默覆盖。
7. GFA 探活 token，刷新 project id 和额度，清除 `invalid_grant` 和 token death strikes，递增 `cliproxySync.revision`，并加入 CLIProxy 重新同步队列。
8. CLIProxy reload 或清除该远端 auth 文件对应的缓存 token。

重新授权成功后，应保留 alias、proxy、绑定卡、套餐元数据和历史用量。

## 后台页面改造

Antigravity 账号页按账号 id 合并 `/api/remote-token/status` 中的运行时健康状态：

- 正常
- 额度冷却中
- 容量冷却中
- 鉴权失效
- 需要验证
- 连续报错

状态列应使用已有的账号状态 badge helper，不再只显示启用或禁用。

新增筛选：

- 全部
- 正常
- 鉴权失效
- 冷却中
- 已禁用
- 同步失败

每一行应提供：

- 刷新 token 和额度
- 重新授权
- 恢复
- 重新同步到 CLIProxy
- 启用或禁用池

CLIProxy 管理页应展示每个账号的同步状态：期望状态、远端文件、最后同步时间、最后错误，以及当前远端文件 revision 是否与 GFA 一致。

## CLIProxy 运行时行为

当还有其它可用 auth 时，CLIProxy 不应把账号级失败立即返回给 new-api。

遇到 `invalid_grant`：

1. 在本地把当前 auth 标记为 blocked。
2. 将失败事件上报给 GFA。
3. 在配置的重试上限内，用下一个可用 auth 重试请求。

遇到 `429`：

1. 只冷却当前 auth 的受影响模型。
2. 条件允许时换另一个 auth 重试。

遇到用户请求错误：

1. 不改变 auth 健康状态。
2. 将错误返回给 new-api。

这个优化不只服务 `gemini-3.1-flash-image`。重试策略基于错误分类，而不是基于模型名，所以也能覆盖其它模型。

## 定时对账

GFA 定时执行对账，例如每五分钟一次：

1. 拉取 CLIProxy auth 文件列表。
2. 根据 GFA 账号和 `cliproxySync` 构建期望的远端文件列表。
3. 检测缺失、陈旧、多余、禁用状态不一致或 revision 不匹配的 auth 文件。
4. 自动执行安全修复：
   - 上传缺失的已启用文件。
   - 禁用或删除死号对应文件。
   - 当 token hash 或 revision 不一致时覆盖陈旧文件。
5. 将无法解决的错误记录到后台展示。

无法映射到 GFA 账号的远端手工文件应显示为 unmanaged。操作员可以保留，也可以手动删除。

## 失败处理

如果 GFA 不可用，CLIProxy 将错误事件写入本地队列，稍后重试上报。请求侧仍使用本地 auth 健康状态，避免重复选择同一个坏 auth。

如果 CLIProxy 不可用，GFA 记录同步错误，并在定时对账时重试。GFA 中的账号健康状态仍然保持权威。

如果事件属于旧 revision，GFA 忽略它。

如果重新授权成功但 CLIProxy 重新同步失败，GFA 显示该账号“鉴权已恢复，但同步失败”。CLIProxy 连接恢复后，操作员可以点击重新同步。

## 安全

GFA 不能记录 refresh token、access token、management key 或完整 credential JSON。

CLIProxy 上报端点使用独立 secret header，没有密钥的请求直接拒绝。

生产环境必须在 GFA API 和 CLIProxy 运行环境中配置同一个 `CLIPROXY_REPORT_SECRET`。CLIProxy 还应配置 `CLIPROXY_GFA_REPORT_URL`，指向容器内可访问的 GFA API 地址。只有当 GFA API 与 CLIProxy 运行在同一网络命名空间且 `127.0.0.1:3001` 可达时，才能依赖默认回调地址；Docker bridge 容器内的 `127.0.0.1` 通常只指向 CLIProxy 容器自己，不能代表宿主机或其它服务器。

同步状态可以存储哈希和远端文件名，但不能存储原始 token。

后台操作继续受现有 console auth 保护。

## 测试

后端测试：

- 账号列表或前端合并数据能显示运行时 `quotaStatus`。
- `invalid_grant` 上报会将账号标为错误，并加入 CLIProxy 禁用同步。
- 旧 revision 上报会被忽略。
- 重新授权会更新目标账号，并清除鉴权死号状态。
- 对账任务会上传缺失的启用 auth，并禁用死号 auth。
- `429` 上报只封禁对应模型。

前端测试：

- 鉴权失效账号显示红色状态。
- 筛选包含鉴权失效和同步失败账号。
- 重新授权动作会发起目标账号 OAuth。
- CLIProxy 页面能显示陈旧、已同步和同步失败状态。

集成测试：

- 模拟 CLIProxy 上报 `invalid_grant`，验证账号离开 GFA 候选池，远端 auth 被禁用。
- 模拟重新授权，验证 revision 递增，并且旧事件被忽略。

## 推进顺序

阶段 1：展示 GFA 账号健康状态并增加筛选。

阶段 2：增加指定账号重新授权。

阶段 3：增加 GFA 到 CLIProxy 的同步状态和手动重新同步。

阶段 4：增加 CLIProxy 到 GFA 的错误回传，并校验 revision。

阶段 5：增加定时对账和 CLIProxy 本地事件重试。

阶段 6：优化 CLIProxy 对所有模型账号级失败的换号重试行为。
