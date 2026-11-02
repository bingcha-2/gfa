# 母号上游本地模拟器

运行（仓库根目录，Node 22+）：

```sh
node tests/claude-desktop-3p/mock-upstream/server.mjs
node --test tests/claude-desktop-3p/mock-upstream/server.test.mjs
```

仅监听 `127.0.0.1:4319`，不访问外网。运营测试 key 固定为 `test-operator-only`，私有测试 key 由模拟器生成。全部状态只存在内存，重启清空。不要配置真实凭据。

提供运营开 key / 按账号查用量接口，以及 Claude `/v1/models`、`/v1/messages`、`/v1/messages/count_tokens`。推理返回固定文本，输入 12、输出 4 tokens。支持普通 JSON 和完整 SSE 事件顺序。运营 key 不能用于推理，私有 key 不能调用运营接口。

开 key 用例支持相同 requestId 重领、参数冲突、已有 key 拒绝重复分配。用量返回精确匹配账号的关联 key，查询不返回密钥。账号自动创建是测试便利，不模拟真实账号目录。

限制：不模拟 GPT、工具执行、真实额度比例变化、24 小时领取过期、故障注入、持久化和上游管理控制台。share 比例是固定合成数据，只有请求数及输入/输出 token 累计。通过这些测试不代表真实上游或 Desktop 端到端验收。

## 接入 GFA 测试环境

1. 启动独立 GFA 测试服务及数据库，不能指向生产数据库。
2. GFA 后台目前要求上游 URL 为 HTTPS。给模拟器加测试 HTTPS 反向代理并让 GFA 信任测试 CA，或在自动化测试中将 UpstreamConfig 直接传给上游客户端。不要关闭生产 TLS 校验。
3. 将测试环境运营地址设为代理地址，运营 key 为上述测试值。
4. 添加一个虚构 Claude 母号，例如 `test+claude@example.test`，推理地址同为代理地址。GFA 应以 people=1 和持久化 requestId 领取一个私有 key。
5. 分配测试用户份额，正常登录并激活 Desktop 3P，Desktop 指向 GFA 测试网关，不能直接指向模拟器；否则会绕过 GFA 鉴权和计费。
6. 发送消息，检查回复、GFA 用量明细及用户累计金额。核对输入 12、输出 4 按所选模型价格计算；count_tokens 和 models 不计推理费。
7. 停止接管检查配置恢复。实际 Desktop 操作及完整 GFA 集成流程仍需单独执行验收。

## 真实上游验收前的已知缺口

- GFA 同步目前取关联 key 数组第一个元素，需要保存开 key 返回的 clients 名称并精确匹配。
- resetAt 任意变化即清零用户额度不够可靠，应结合 freshness、有效周期前进及原子更新，防止误清零和漏清零。
- 网关计费失败需要可靠重试；并发检查和占位需要原子化。
- 私有开 key 会自动启用账号。“公共禁用”仅可作为测试准备态；实际推理时需要私有且启用。不要自动调用转公共并删除 key 的接口清场。
