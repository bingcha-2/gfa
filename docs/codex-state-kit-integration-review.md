# GFA Codex 兼容性修复与 STATE 借鉴方案

日期：2026-09-20。范围：代码修复与公开源码审查；未发布客户端、未改生产配置、未执行账号采集。

## 本次修复

- Chat 转码支持 GPT-6 的 reasoning_effort，并保留 developer 消息角色。
- Chat JSON/SSE 回译保留上游 model；缺失时为空，不使用请求模型冒充响应模型。
- GPT-6 Chat 请求携带工具、reasoning、compaction、configuration_update、工具调用历史或 previous_response_id 时明确返回 400，要求配置 Responses。纯文本 Chat 仍可用；不静默更换用户配置的接口。
- 号池 HTTP 和本地中转诊断分别记录 requested_model、sent_model、upstream_model。模型不一致是路由观察值，不等于模型质量证明。合法别名和快照也可能导致字符串不相等，当前只记录，不自动降级或封禁账号。
- 模型不一致的完成响应保留诊断上报；原有计量逻辑保留。
- STATE 从请求头审计中排除，不改变协议透传。
- Chat 流内错误、缺少结束信号、读取失败不再合成 response.completed；非流式错误或不可解析响应返回 failed。

## 审查的外部实现

仓库：https://github.com/wangyunjeff/sub2api-state-kit

审查时 main HEAD：31420adaaf2b29ea1ad6bafd108c268b7b8df441。源码用于理解设计，本次没有复制实现或安装其插件。

关键文件：

- `plugin/internal/engine/observer.go`：独立的完成响应观察器，支持分块、SSE 多行与 JSON；缓冲上限 1 MiB；缺失模型、异常帧不能用于验证票据。
- `plugin/internal/engine/engine.go`：票据按账号和模型索引；校验业务代理、身份、配置摘要及到期时间；receipt 携带 generation/version；旧请求不能使新版本失效，持久化删除前再次检查。
- `plugin/internal/engine/harvest.go`：同账号模型仅运行一个维护任务；全局并发受控；失败冷却；恢复票据须经业务出口复验；401/403/429 终止本轮。
- `plugin/internal/engine/transport.go`：观察与透传分离；完整完成事件送出时即可处理模型不一致，不必等待 EOF；不重放业务请求。
- `overlay/backend/internal/service/openai_codex_ticket_watchdog.go`：在注入点绑定 receipt，并核对账号、模型、配置版本、出口、状态摘要和采集时间。

292/332/312 是 STATE 长度。312 是实验信号，不能当 HTTP 状态码或官方撤销协议。源码默认 TTL 60 分钟、提前 10 分钟维护是本地策略，不是服务端有效期承诺。

## 适配 GFA 的建议

GFA 服务端发租约，客户端负责数据请求。Sub2API 的插件和进程内锁不能直接接管 GFA；应自行实现边界明确的组件。

### 第一阶段：完善观测

沿用客户端的流诊断，后续统一 WebSocket 与 HTTP 的解析、终态、有效 reasoning effort 和 request ID。正式调度只参考完整成功响应的模型，不使用 response.created 或长度作为健康证明。SSE 多行事件及大帧需补协议级覆盖。

服务端新增账号＋模型级健康摘要，区分 invalid_prompt、capacity、429、模型不一致、上下文错误、传输失败。invalid_prompt 不触发自动换 IP 或账号反复试探；保留原始错误码用于最小请求对照。模型字符串不等先记录，再按确认的别名规则归一化。

### 第二阶段：受控状态管理

建议增加服务端 `CodexStateCoordinator` 与客户端 `CodexStateObserver`，初始默认 disabled/observe。保持现有正常转发，先验证状态字段在 GFA 实际链路中的出现和关联。

服务端状态元数据应包含 accountId、model、sessionScope、egressRevision、identityRevision、version、observedAt、expiresAt、验证状态。会话隔离默认开启；账号级跨会话复用需要额外验证。若存储状态原文，应加密并与运营日志分离，客户端只获得当前租约所需状态。

客户端每次使用状态时绑定 receipt，报告 requestId、leaseId、accountId、model、version、出口版本、完成状态与响应模型。服务端认证租约归属、去重，并使用比较版本更新；旧客户端或旧请求不得覆盖新状态。单个客户端报告作为信号，不能直接撤销共享账号的新状态。

后台任务由服务端协调。同一账号模型只允许一个维护任务；多服务实例需数据库或共享存储租约，不能只靠 Node/Go 进程内锁。更新、关闭开关和出口变化时增加 generation，取消旧任务。有效旧状态在普通续期失败时可保留；已明确失效的版本不可重新启用。

业务请求不得等待采集过程，也不得在已有输出或工具调用后重放。状态缺失时的行为要显式配置；试验初期仅观察，避免状态模块使正常账号不可用。客户端侧不能在业务出口失败后悄悄换出口并继续宣称状态已验证。

### 第三阶段：验证效果后再讨论复用

固定模型、effort、测试任务和账号/出口条件，交错进行对照测试；记录请求数、成功率、invalid_prompt 率、模型不一致率、首字延迟和任务正确率。完整响应的 model 相同也不等于“满血”；不能用回答长短或推理 token 单独判断。

不把动态换 IP 采集、跨会话注入或 312 自动撤销当作默认生产策略。先验证正常会话状态保持是否有收益，再决定是否值得引入额外维护系统。

## 第 2、3 步已实施（2026-09-20）

- Go 客户端增加结构化 Codex 诊断：生成终态、错误码、请求/发送/响应模型、推理强度、request/response ID、会话哈希、出口配置摘要和变化标记。原始 STATE、账号令牌与提示词不进入诊断字段。
- HTTP SSE 观察支持多行 data、分块输入、普通 JSON；观察缓冲限制 1 MiB，超限仍原样转发，单独标记 observationLimited，不能把这种缺失终态用作调度失败证据。
- WS 改为按 response ID 分别观察和上报，一条连接多轮不会只记录最大 usage；已完成 ID 去重，断开时上报未完成轮次。只从上游响应读取 usage，不采信客户端帧伪造的用量。桥接结束后关闭两端并等待两个泵退出。
- 服务端校验诊断字段，完整元数据随现有请求日志 reason JSON 保存；状态接口仅返回账号/模型的健康分类摘要，不公开会话哈希和请求 ID。账号健康修改必须绑定已验证租约，不能由 payload.accountId 指定。
- 生成结果与计量分开：HTTP 200 内 response.failed 不再恢复账号健康。invalid_prompt、上下文拒绝、输出未完成及模型字符串不一致不触发账号轮换或冷却；capacity、限速、传输失败按账号和租约模型有限冷却。429 使用具体错误码区分限速与额度耗尽，并接收 Retry-After。
- 新客户端会话亲和按订阅、设备、会话哈希隔离，跨模型优先复用仍合格的账号。选择后在异步刷新令牌前同步预留，避免并发请求因刷新等待而重新分配。临时容量/限速冷却时，同会话返回可重试的 503 及 Retry-After，不为一次暂时错误自动切换账号。
- 有会话标识且已绑定代理的 HTTP 请求不再在传输失败后换出口重放。出口标识是代理配置摘要，不是探测到的真实公网 IP。已观察到账号变化时剥离旧 x-codex-turn-state；现有已确认额度耗尽的溢出规则保留。
- 服务端以请求时间顺序保护健康状态，旧成功响应不能清除较新失败产生的冷却。仅观测的新模型字符串差异不会直接封禁账号。

运行边界：会话亲和、近期健康状态与客户端连续性缓存有容量限制，属于进程内状态，重启后会重建；没有新增跨实例一致性存储。没有会话标识的旧客户端保留原亲和方式。WS 在同一连接内换模型时，上报会保留实际模型；调度状态只允许影响租约授权的原模型，避免客户端指定任意模型使其冷却。

## 尚未完成的范围

- 未新增控制台图表；详细诊断可从请求日志读取，近期健康分类从现有状态接口读取。
- 没有修复或证明上游 invalid_prompt 根因；没有启用 STATE 注入、采集或自动换号。
- 现有 encrypted_content 外形检查不能证明跨账号可解密。
- 会话账号亲和已实施，但不自动删除或迁移 encrypted_content；账号不可用后跨账号历史恢复的兼容性仍需单独验证。

## 验证结果

使用本地 Go 工具链，APPDATA 指向专用测试目录。针对转码、代理、模型真实性、STATE 头过滤和流式诊断执行回归，57 个测试条目（含子测试）通过，包测试退出码 0；git diff --check 通过。未运行整个仓库测试或生产调用。

第 2、3 步追加验证：客户端相关回归 88 个测试条目（含子测试）通过；服务端 `lease-service.spec.ts` 与 `codex-health.spec.ts` 合计 73 项通过；服务端 TypeScript 检查通过。测试范围包含多轮 WS、重复完成事件、SSE 多行和大帧、会话独立亲和、跨模型保持账号、按模型冷却、旧成功晚到、invalid_prompt 不触发冷却、未绑定租约的诊断不能操作账号。

```text
go test . -run 'Test(ConvertResponsesToChat|ConvertChatToResponses|StreamChatToResponses|CodexProxy|FilterReportHeaders|CodexTranslatedModel|CodexChatFailure|CodexChatJSONFailure|GPT6ChatState|CodexModelMismatch|CodexStreamDiagnostic)' -count=1 -timeout=120s
```
