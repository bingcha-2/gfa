# Codex 远程托管授权流程

Codex Desktop 在 macOS 上把 Keychain 的 `Codex Auth` 作为登录事实来源。远程托管接管按下面的顺序处理授权状态：

1. 先退出正在运行的 Codex，撤销 GFA 之前写入的本地账号投影。
2. 只读检查当前 OAuth。macOS 优先检查 Keychain，其他平台检查 `auth.json`。
3. 只有同时存在完整 `id_token`、`access_token`、`refresh_token`，且 access token 不在 5 分钟内过期时，才保留 OAuth 能力。
4. 未登录、OAuth 已过期/临近过期、旧版 GFA 残留或 API-Key 状态，统一投影为：
   - `auth.json`：`auth_mode=apikey`、`OPENAI_API_KEY=gfa_codex_takeover`
   - macOS Keychain：删除对应的 `Codex Auth` 投影，避免 Desktop 优先读到旧 OAuth
   - `config.toml`：`cli_auth_credentials_store="file"`、`requires_openai_auth=false`
5. 接管完成后重启 Codex，让 Desktop 重新读取配置和凭据。

投影前会把用户原有的 `auth.json` 与 Keychain 状态保存到受管备份；取消接管时，仅当凭据仍是 GFA 最后写入的投影，才会恢复备份，避免覆盖用户在接管期间主动完成的新登录。

## macOS 只读诊断

用户仍遇到登录页时，可让其执行仓库中的诊断脚本。脚本不会打印 token 内容，也不会删除或修改凭据：

将 `scripts/diagnose-codex-oauth.sh` 保存到本机后运行：

```bash
bash ./scripts/diagnose-codex-oauth.sh
```

看到 `EXPIRED` 或 `NEAR_EXPIRY(<5m)` 时，重新点击一次远程托管即可由客户端自动清理 Keychain 并切换到 API-Key/file；不需要手工删除其他 Keychain 项。
