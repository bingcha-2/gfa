# 基于 Rosetta 账号池的 CLIProxy 上号功能设计

我们将把 CLIProxy 远程上号页面（`/console/rosetta-cliproxy`）的数据源，由原有的数据库子号池（`AgentAccount` 数据表）完全替换为本地的 Rosetta 账号池（即 `C:\Users\Administrator\AppData\Roaming\Antigravity\rosetta\accounts.json` 中的账号）。

## 拟议的修改

### 后端修改

我们将把 CLIProxy 管理相关的 API 路由和逻辑从 `AgentAccount` 模块完全迁移到 `Rosetta` 模块中，封装在 `RosettaService` 和 `RosettaController` 内。

#### 1. 修改 `RosettaController` ([rosetta.controller.ts](file:///c:/Users/Administrator/Desktop/GFA/apps/api/src/rosetta/rosetta.controller.ts))
新增两个管理接口：
- `GET /api/rosetta/cliproxy-status`：查询远程 CLIProxyAPI 的运行状态及已加载的凭证文件列表。
- `POST /api/rosetta/upload-cliproxy`：将选中的 Rosetta 账号批量上传至远程 CLIProxyAPI 服务器。
  - 请求体 Payload 格式：
    ```typescript
    interface UploadCliProxyDto {
      ids: number[]; // Rosetta 账号的数字 ID 数组
      clientId?: string;
      clientSecret?: string;
    }
    ```

#### 2. 修改 `RosettaService` ([rosetta.service.ts](file:///c:/Users/Administrator/Desktop/GFA/apps/api/src/rosetta/rosetta.service.ts))
实现上述两个 CLIProxy 相关方法：
- `getCliProxyStatus()`：
  - 调用 `process.env.CLIPROXY_BASE_URL/v0/management/auth-files` 获取远程服务器的文件列表，并带上 `process.env.CLIPROXY_MANAGEMENT_KEY` 鉴权头。
- `uploadToCliProxy(ids: number[], customClientId?: string, customClientSecret?: string)`：
  - 读取本地 AppData 目录下的 `accounts.json`。
  - 根据传入的数字 `ids` 查找对应的账号。
  - 对每个找到 of 账号，使用对应的客户端凭证（Wails凭证、Google SDK默认凭证或自定义凭证）换取 Access Token，并通过探测接口发现项目的 `projectId`。
  - 构建 CLIProxy 凭证 JSON 并 POST 到远程 CLIProxyAPI 接口。
  - 返回批量执行的统计结果（成功、更新、失败数及错误详情）。

我们从 `AgentAccountService` 中将成熟的 `discoverProjectId` 探测方法复制并整合进 `RosettaService`，以支持自定义客户端凭证的探测。

#### 3. 清理/废弃 `AgentAccount` 中的相关逻辑
- 移除 `AgentAccountController` 中原有的 `upload-cliproxy` 和 `cliproxy-status` 接口。
- 保留数据库底层的基本表操作，但完全剥离对 CLIProxy 的上号调用，确保职责单一。

---

### 前端修改

#### 1. 修改 CLIProxy 远程上号管理页面 ([page.tsx](file:///c:/Users/Administrator/Desktop/GFA/apps/web/src/app/console/(dashboard)/rosetta-cliproxy/page.tsx))
- **数据加载**：
  - 将原有的请求 `/api/agent-accounts` 改为请求 `/api/rosetta/accounts` 获取账号列表。
  - 由于本地 Rosetta 账号返回的是全量数组且不支持数据库级别的物理分页，我们将前端列表改为纯客户端分页、检索和排序，以获得更极致流畅的交互体验。
- **账号状态映射**：
  - 绑定 Rosetta 账号返回的各属性。
  - 通过比对从 `cliproxy-status` 获取的已加载文件名（`gemini-邮箱-projectId.json`）中是否包含该账号邮箱，动态在前端计算其是否为“已上号”状态。
- **页签（Tabs）重新设计**：
  - 舍弃原先老子号特有的生命周期页签，替换为更契合本地账号池的页签：
    - **全部**：展示所有 Rosetta 账号。
    - **已启用**：仅展示 `enabled !== false` 的账号。
    - **已上号**：仅展示已在 CLIProxy 服务端发现凭证文件的账号。
    - **未上号**：展示已启用、有 Token 但尚未上传到 CLIProxy 的账号（即等待上号的候选账号）。
- **批量上号动作**：
  - 前端点击“批量上号”时，将选中的数字 ID 数组及填写的客户端凭证发送至新接口 `/api/rosetta/upload-cliproxy`。

---

## 验证计划

### 手动验证
1. 在浏览器中打开 `/console/rosetta-cliproxy` 页面。
2. 确认表格中加载出的账号数据，完全与本地 `C:\Users\Administrator\AppData\Roaming\Antigravity\rosetta\accounts.json` 一致。
3. 测试上方过滤页签（全部/已启用/已上号/未上号），检查列表筛选是否正确。
4. 勾选 1 个或多个未上号账号，使用默认凭证或 Wails 凭证，点击“批量上号 到 CLIProxy”。
5. 检查上号完毕后，列表中对应账号的“状态”列是否动态变更为“已上号 (UPLOADED)”，并且在左侧“已加载凭证文件”卡片中能实时查看到对应的 JSON 配置文件。
