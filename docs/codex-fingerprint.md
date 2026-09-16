# Codex 指纹收敛

管理后台 → Codex 账号 →「指纹收敛」按账号选择，新账号及未配置的账号默认关闭。

| 模式 | 行为 |
| --- | --- |
| 关闭 | 保留原始标识 |
| 仅设备 | 统一 installation ID，保留会话、线程、缓存键 |
| 设备＋会话 | 统一设备和 session ID；线程按账号、客户端设备和原始线程/会话隔离 |
| 完全收敛 | 统一设备、会话、线程；独立 turn ID 和原始时间仍保留 |

本功能借鉴 [sub2api 指纹收敛的模式设计](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/service/openai_codex_fingerprint.go)，按 GFA 的服务端租约＋客户端直连架构独立实现。实现未复制该项目源文件。

## 身份生命周期

首次启用时服务端生成随机 UUID seed，保存在 `codex-accounts.json` 的账号记录内。租约只下发派生后的 installationId、sessionId、namespace 和 mode，不下发原始 seed。刷新 token、同账号重新导入、服务重启、关闭再开启均保留身份。备份恢复须保留账号文件；不同独立部署的相同数字账号 ID 不会产生相同身份。导入为新账号不会接受输入 seed。

管理接口：`POST /api/console/rosetta/codex-fingerprint`，沿用控制台鉴权，正文为 `{"accountId":1,"mode":"device"}`。只接受 off/device/session/full；关闭通过显式 off 写入。

## 请求一致性

- HTTP Responses、compact、图像请求和 WebSocket 首帧及后续 response.create 使用同一改写函数。
- 请求头、client_metadata 及内嵌 x-codex-turn-metadata 使用一致的设备、会话、线程标识；保留其他元数据及输入正文。
- session/full 模式仅在 prompt_cache_key 等于原始会话或线程时改为收敛后的线程 ID，自定义缓存键保持不变。
- window ID 独立派生；不伪造 turn ID、轮次开始时间或设备证明。
- 换号重试从未收敛的输入重新构建；租约身份跟随实际出站账号，不跟随用于显示额度的绑定账号。
- 模型目录及额度探针只带账号设备身份，不注入会话/轮次。中转 API key 模式跳过收敛。
- 缺少有效配置、非法请求体及 WS 控制消息保持原样。session 模式缺少原始线程/会话标识时按客户端设备隔离；客户端应提供会话 ID 以进一步区分本机不同对话。

## 发布与回滚

需要同时部署服务端、后台网页并发布包含此功能的桌面客户端。老客户端会忽略新租约字段；新客户端连接老服务端默认不收敛。后台保存后，下一次租约/请求生效，已建立的 WebSocket 保持连接建立时的身份，需重连生效。

初次使用可在少量测试账号选择「仅设备」验证实际请求。完全收敛会合并线程身份，不适合作为默认设置。关闭即可回退，账号 seed 留存以免再次开启时更换身份。本功能不保证增加额度或改变上游账号策略。
