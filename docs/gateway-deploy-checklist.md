# 第三方 Claude 网关:部署与待办清单

分支:`feat/third-party-gateway`。设计背景见 [third-party-claude-gateway-plan.md](third-party-claude-gateway-plan.md),上游实测记录见 [upstream-newapi-probe.md](upstream-newapi-probe.md)。

状态标记:`[ ]` 未做,`[x]` 已做。每次部署或修复后更新本文件。

## 1. 部署前必做

- [ ] 服务器 `.env` 加 `GATEWAY_KEY_KEK`(32 字节随机值,hex 64 位)。丢失后库里已存的母号 key 全部无法解密,务必与数据库备份分开保管。
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- [ ] 备份数据库,再执行 `pnpm db:migrate`,应用迁移 `20261101090000_gateway_mother_account` 和 `20261101120000_gateway_users`。
- [ ] 重新构建服务端和后台(`scripts/run-production.ps1` 使用 `--no-build`,不会自动构建)。
- [ ] 重载 Caddy,使 `/api/gateway/*` 路由生效(已改 `Caddyfile`:转发到 `:3001`,`flush_interval -1` 关闭缓冲以支持 SSE)。
- [ ] 确认服务器能访问 `https://pool1.tk4me.com`。上游若有 IP 白名单,把服务器出口 IP 加进去(上游文档未说明)。
- [ ] 在后台「第三方母号」页添加母号时填写该账号的运营 Key 和 API 基址。地址留空使用 `https://pool1.tk4me.com`，[三方控制台](https://pool1.tk4me.com/teamclaude/console)用于网页操作。

## 2. 冒烟测试顺序

1. [ ] 添加 1 个母号:状态应为「正常」,模型数大于 0。
2. [ ] 验证**开出的私有 key**能调用上游 `/v1/models` 和 `/v1/messages`。此前只用运营 key 测过,私有 key 的路径和鉴权头尚未验证。
3. [ ] 「网关用户」页给自己的账号分配 1 份,用客户端登录后点「一键托管」,发一个小请求。
4. [ ] 核对「已用」金额与预期一致;用 `GET /api/gateway/v1/models` 核对模型列表。
5. [ ] 额度用尽测试:把每份额度临时调小,确认请求被拒绝(429,提示额度已用完)。
6. [ ] 取消托管:确认 `~/.claude/settings.json` 只还原了被改的键,hooks 和权限设置未丢。
7. [ ] 流式请求测试:确认响应逐块到达,没有被缓冲。

## 3. 已知缺口

按风险从高到低:

- [ ] **私有 key 的推理调用未验证**(见 2.2)。
- [ ] **服务器承担全部转发流量。** 只有单用户并发上限 4,没有全局并发上限。服务器较弱时先小范围测试。
- [x] **`claude-haiku-5-5` 价格已补**(2026-11-02,来源 Anthropic 官方定价页):提示词 ≤100K 输入 0.10 / 输出 0.50,>100K 输入 0.50 / 输出 2.50(每百万 token 美元),缓存读写另计。`effectiveFrom` 的上线日期未核实。
- [ ] **上游 usage 偶发偏高。** `www.tk4me.com` 上同一个短请求出现过输入 token 为 4106、4111(正常约 10)。`pool.tk4me.com` 上单次测试未复现。当前没有保护,偏高会直接计入用户用量。需向上游确认原因。
- [ ] **激活接口不校验设备是否被吊销。** 被吊销设备的用户在 JWT 有效期内仍可激活并取得 key;分配额度是唯一的闸。
- [ ] **并发下可能小幅超额。** 额度只在请求前检查,最多超出在途请求(上限 4)的金额。已确认可接受。
- [ ] **用量明细表无清理策略。** `GatewayUsage` 每个请求一行,量大后需要归档或清理。
- [ ] **删除母号不会吊销上游已开出的 key。** 需要在上游把账号转公共池并删除 key。
- [ ] **客户端没有额度与剩余的界面。** 只在托管成功的提示里显示一次。
- [ ] **没分配额度的用户回退到旧的租号接管**,该路径仍要求 TUN 和出口检查。
- [ ] **托管后用户可以手动改回不支持的模型。** 托管时只会移除当时母号不支持的写死模型,之后用户自己再写回去,请求会被网关以「不支持的模型」拒绝。
- 说明:写进用户 `settings.json` 的是用户专用 key(`gfa-` 开头),不是母号 key;文件和备份已设为 0600。

## 4. 上线后的安全事项

- [ ] 轮换对话中暴露过的上游凭证:运营 Key(`tc-op-…`)和测试渠道 Key(`sk-…`)。
- [ ] 向上游申请只含「开 key」和「查用量」权限的受限凭证,替换运营 Key(两份上游文档末尾都推荐)。
- [ ] 确认 `GATEWAY_KEY_KEK` 已单独备份,且未提交到仓库。
- [ ] 后台只对内网或 VPN 开放。

## 5. 验证状态(截至上次提交)

- 服务端类型检查通过;`gateway-pool` 下 11 个单元测试通过。
- 桌面端前端 42 个接管相关测试通过。
- 桌面端 Go 编译通过;新增的 7 个网关测试通过。
- 7 个原有 Go 测试(sanitize、竞争配置检测、Codex 本地接管)在干净的 HEAD 上同样失败,与本次改动无关,未修复。
- **未做**:对真实上游的端到端联调;迁移未应用到任何数据库;未在真实 Claude Code 中验证 `ANTHROPIC_API_KEY` 置空是否触发警告。

## 6. 文档债

- [ ] [third-party-claude-gateway-plan.md](third-party-claude-gateway-plan.md) 和 [third-party-claude-gateway-api.md](third-party-claude-gateway-api.md)(含 `.docx`)是早期设计,没有反映份额、专用 key 和服务端转发,需要按现状重写。
