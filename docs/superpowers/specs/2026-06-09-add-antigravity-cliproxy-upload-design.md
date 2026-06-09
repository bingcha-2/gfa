# 增加 Antigravity OAuth 远程上号设计

为了支持在 `rosetta-cliproxy` 页面将本地 Rosetta 账号同时上号到 `Gemini CLI OAuth` 和 `Antigravity OAuth`，本设计将在 GFA 后端及前端进行通道分流改造，并在界面增加通道选择。

## 方案设计

### 1. 后端修改

#### 1.1 `rosetta.controller.ts` ([rosetta.controller.ts](file:///c:/Users/Administrator/Desktop/GFA/apps/api/src/rosetta/rosetta.controller.ts))
- 将 `POST /api/rosetta/upload-cliproxy` 接口参数扩展，接收 `provider?: "gemini" | "antigravity"`。
  ```typescript
  interface UploadCliProxyDto {
    ids: number[];
    clientId?: string;
    clientSecret?: string;
    provider?: "gemini" | "antigravity";
  }
  ```

#### 1.2 `rosetta.service.ts` ([rosetta.service.ts](file:///c:/Users/Administrator/Desktop/GFA/apps/api/src/rosetta/rosetta.service.ts))
- 更新 `uploadToCliProxy` 方法签名以包含 `provider: "gemini" | "antigravity" = "gemini"`。
- 根据 `provider` 决定要上传的文件名格式和凭证 JSON 的组织形式：
  - **Gemini CLI OAuth (`provider === "gemini"`)**:
    - 文件名：`gemini-${email}-${projectId}.json`
    - JSON 结构：使用嵌套的 `token` 对象，并设置 `type` 为 `"gemini"`。
  - **Antigravity OAuth (`provider === "antigravity"`)**:
    - 文件名：`antigravity-${email}.json`
    - JSON 结构：使用扁平属性对象，并设置 `type` 为 `"antigravity"`。
      ```json
      {
        "type": "antigravity",
        "email": acc.email,
        "project_id": projectId,
        "refresh_token": acc.refreshToken,
        "access_token": accessToken,
        "expires_in": 3600,
        "timestamp": Date.now(),
        "expired": new Date(Date.now() + 3600 * 1000).toISOString()
      }
      ```
    - 为了填充 `access_token`，若本地 token 缓存不存在或已过期，将自动通过 Google OAuth Endpoint 使用对应的 `OAUTH_CLIENT_ID` 和 `OAUTH_CLIENT_SECRET` 进行一次 Token 交换。

### 2. 前端修改

#### 2.1 `page.tsx` ([page.tsx](file:///c:/Users/Administrator/Desktop/GFA/apps/web/src/app/console/(dashboard)/rosetta-cliproxy/page.tsx))
- **添加通道选择 UI**：
  在“OAuth 凭证选择”卡片或者“可用子号池列表”的操作栏中，增加一个下拉选择框（Select）或单选框（Radio Group），提供：
  - Gemini CLI OAuth (gemini-cli)
  - Antigravity OAuth (antigravity)
  - 默认选中 `Gemini CLI OAuth`。
- **发送请求逻辑调整**：
  在 `handleBatchUpload` 中，根据用户所选的通道，将对应的 `provider` 作为参数传递给后端 `/api/rosetta/upload-cliproxy` 接口。
- **状态比对逻辑更新**：
  当前的 `isUploaded` 只粗糙地根据邮箱是否存在于已上传的文件列表来判断。为了能在界面上清晰区分账号在 Gemini CLI OAuth 和 Antigravity OAuth 的上号状态，我们将它扩展为：
  - `isUploadedToGemini(email)`: 检查文件列表中是否有 `gemini-${email.toLowerCase()}-` 开头的文件。
  - `isUploadedToAntigravity(email)`: 检查文件列表中是否有 `antigravity-${email.toLowerCase()}.json` 的文件。
  - 在列表中将“状态”列的 Badge 改造为同时展示两个通道的独立上号状态（例如：Gemini: [已上号/未上号]，Antigravity: [已上号/未上号]），这样管理员能一目了然。

---

## 验证计划

### 1. 自动与手动功能测试
1. 在 `/console/rosetta-cliproxy` 页面上选择通道为 `Antigravity OAuth`。
2. 勾选账号，执行批量上号。
3. 检查控制台弹窗和 toast，应该显示上传成功。
4. 在左侧的“已加载凭证文件”卡片中，查看是否成功加载了 `antigravity-${email}.json` 凭证。
5. 通过 `http://154.12.88.124:8317/management.html#/auth-files` 页面查看和校验文件内容和 Provider 是否正常显示为 `antigravity`。
