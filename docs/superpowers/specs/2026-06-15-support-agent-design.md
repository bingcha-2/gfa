# 客户端客服 Agent(全自动对话客服)设计

- 日期:2026-06-15
- 状态:待用户评审 → 实现

## 目标

在客户端(`account` 侧)右下角加一个**悬浮客服气泡**,点开是一个**全自动实时对话客服机器人**。机器人基于大模型 + agent 工具循环,能:

1. **查本人信息**——读当前登录客户的资料/订阅/订单,给出具体回答而非空话。
2. **FAQ 检索**——基于已发布 FAQ 回答常见问题(怎么用、怎么付费、怎么接入)。
3. **创建/升级工单**——解决不了或客户要求人工时,自动把对话转成一个 `Ticket` 转人工,接入现有工单体系。

**不做**:任何高风险写操作(改密码、重发密钥、重启租约等)。v1 只读 + 建工单。

## 决策(已确认)

| 维度 | 决定 |
|---|---|
| 工作模式 | 全自动实时对话客服(客户端聊天,agent 直接多轮对话) |
| 模型渠道 | 国内供应商,走 **OpenAI 兼容接口**,env 可切换(DeepSeek / 千问 / 豆包) |
| Agent 框架 | **不用框架**,`openai` 官方 Node SDK + **手写 tool-calling 循环** |
| 实时传输 | **SSE 流式**(NestJS 原生 `@Sse()` / raw response,无新基建) |
| 入口 | 客户端右下角**悬浮气泡**,挂在 `account` 布局 |
| 能力 | 查本人信息(资料/订阅/订单)+ FAQ 检索 + 创建/升级工单 |
| 持久化 | 新增 Prisma `SupportConversation` / `SupportMessage` |
| 范围 | v1 仅客户端 bot;后台「管理员回看机器人对话」列为 Phase 2(本次不做) |

## 背景 / 可复用资产

- **现有工单体系完整**:`TicketService.create(customerId, subject, body)`(`apps/server/src/leasing/account/ticket/ticket.service.ts`)直接复用做升级转人工。
- **客户数据 service 现成**:
  - `CustomerAuthService.getProfile(customerId)` —— 客户资料 + 余额 `creditCents`。
  - `BillingService.listSubscriptions(customerId)` —— 订阅列表。
  - `BillingService.listOrders(customerId, page, pageSize)` —— 订单列表。
- **FAQ**:`FaqItem`(Prisma,字段 `category/question/answer/published/sortOrder`),已有 `FaqService` 读已发布列表(`apps/server/src/shared/faq/`)。
- **客户认证**:`CustomerJwtGuard` + `@CurrentCustomer()` 装饰器,`request.user.customerId` 即当前客户 id —— **所有工具的数据隔离锚点**。
- **前端**:Next.js 15 + React + shadcn + Tailwind;客户端 fetch 封装 `apps/web/src/lib/account/user-api.ts`。
- **约束**:项目**没有** `@anthropic-ai/sdk` / `openai` / WebSocket / SSE 基建,均需新增最小依赖。Codex 模块是账号共享服务,**不能**拿来跑对话。

## 后端

### 新模块 `apps/server/src/leasing/account/support-agent/`

```
support-agent/
  support-agent.module.ts        # NestJS module,导入 Ticket/Billing/CustomerAuth/Faq 等
  support.controller.ts          # CustomerJwtGuard 守卫的客户端端点
  support-agent.service.ts       # agent 编排 + 工具循环 + 流式
  conversation.service.ts        # 会话/消息持久化(Prisma)
  llm/
    llm.client.ts                # openai SDK 封装,指向 env 配置的兼容端点
  tools/
    index.ts                     # 工具注册表(name → {schema, handler})
    get-my-profile.tool.ts
    get-my-subscriptions.tool.ts
    get-my-orders.tool.ts
    search-faq.tool.ts
    create-support-ticket.tool.ts
  prompt/
    system-prompt.ts             # 人设 + 范围 + 升级规则
```

### LLM client(`llm/llm.client.ts`)

- 依赖:新增 `openai` 包。
- 配置(env,三个值换供应商不改代码):
  ```
  SUPPORT_LLM_BASE_URL   # 如 https://api.deepseek.com
  SUPPORT_LLM_API_KEY
  SUPPORT_LLM_MODEL      # 如 deepseek-chat / qwen-plus / 豆包接入点ID
  ```
- 还需:`SUPPORT_LLM_MAX_TOOL_ITERS`(默认 6)、`SUPPORT_AGENT_ENABLED`(总开关,未配置 key 时关闭并隐藏前端气泡)。
- 用标准 `chat.completions.create({ model, messages, tools, stream: true })`。

### 工具集(`tools/`)

每个工具一个文件,导出 `{ name, description, parameters(JSON schema), handler(args, ctx) }`。**`ctx.customerId` 由服务端从 JWT 注入,工具 schema 里不暴露 customerId,绝不信任模型传入的 id。**

| 工具 | schema 入参 | 后端调用 | 备注 |
|---|---|---|---|
| `get_my_profile` | 无 | `CustomerAuthService.getProfile(ctx.customerId)` | 返回资料 + 余额 |
| `get_my_subscriptions` | 无 | `BillingService.listSubscriptions(ctx.customerId)` | **脱敏**:删 `backingKeyValue` 等密钥字段 |
| `get_my_orders` | `{ page?, pageSize? }` | `BillingService.listOrders(ctx.customerId, page, pageSize)` | 默认第一页 |
| `search_faq` | `{ query: string }` | 读已发布 FAQ + 关键词匹配,返回 top-N | 答案 HTML 转纯文本再喂模型 |
| `create_support_ticket` | `{ subject, body }` | `TicketService.create(ctx.customerId, subject, body)` | 升级转人工;返回 ticketId,前端给跳转卡片 |

返回模型前统一:**脱敏 + 体积截断**(单工具结果上限,防止超长把上下文撑爆)。

### Agent 编排(`support-agent.service.ts`)

`async *run(ctx, conversationId, userText)` —— async generator,逐段 yield SSE 事件:

1. 落库用户消息,载入该会话历史(限最近 N 条,防超长)。
2. 拼 `messages = [systemPrompt, ...history, userText]`。
3. 工具循环(最多 `MAX_TOOL_ITERS` 轮):
   - 调 LLM(stream)。流式文本 → `yield { type: 'delta', text }`。
   - 若有 `tool_calls`:`yield { type: 'tool', name }`(前端显示「正在查询你的订阅…」),逐个执行(注入 `ctx.customerId`),把 assistant + tool 结果 push 回 `messages`,`continue`。
   - 无 tool_calls → 最终回答,break。
4. 落库 assistant 消息(含 tool 调用痕迹),`yield { type: 'done', conversationId }`。
5. **兜底**:LLM 报错 / 工具解析失败 / 超过轮数上限 → `yield { type: 'error' }` + 友好兜底文案,并建议「需要的话我可以帮你转人工」。豆包等 function-calling 不稳时降级为纯文本回复,不崩。

### 接口(`support.controller.ts`,`@UseGuards(CustomerJwtGuard)`)

```
POST /api/account/support/chat        # body { conversationId?, message }
  → SSE 流:event: delta|tool|done|error
GET  /api/account/support/conversation # 载当前客户最近会话历史(重开气泡续聊)
```

`customerId` 一律来自 `@CurrentCustomer()`,与会话归属强校验(`conversation.customerId !== ctx.customerId` → 403)。

### 数据模型(Prisma 新增)

```prisma
model SupportConversation {
  id         String           @id @default(cuid())
  customerId String
  status     String           @default("OPEN")   // OPEN | ESCALATED | CLOSED
  ticketId   String?                              // 升级后关联的工单
  createdAt  DateTime         @default(now())
  updatedAt  DateTime         @updatedAt
  customer   Customer         @relation(fields: [customerId], references: [id])
  messages   SupportMessage[]
  @@index([customerId, updatedAt])
}

model SupportMessage {
  id             String              @id @default(cuid())
  conversationId String
  role           String              // USER | ASSISTANT | TOOL
  content        String              // 文本;TOOL 存工具名+结果摘要(JSON 字符串)
  toolCalls      String?             // assistant 发起的 tool_calls(JSON)
  createdAt      DateTime            @default(now())
  conversation   SupportConversation @relation(fields: [conversationId], references: [id])
  @@index([conversationId, createdAt])
}
```

`Customer` 加反向关系 `supportConversations SupportConversation[]`。迁移用 `prisma migrate`。

### 系统提示(`prompt/system-prompt.ts`)要点

- 人设:GFA 中文客服,语气友好简洁。
- 范围:只答本产品(账号租赁/订阅/付费/接入)相关;无关问题礼貌拒答。
- 必须**先查工具再答事实**(订阅状态、订单、余额、FAQ),不得编造。
- **升级规则**:解决不了 / 涉及退款 / 账号安全 / 客户明确要人工 → 调 `create_support_ticket` 转人工并告知工单号。
- 数据隔离:只谈当前客户自己的数据,绝不提及他人信息。

## 前端

### 悬浮组件 `apps/web/src/components/account/support-chat-widget.tsx`

- 挂在 account 布局(`apps/web/src/app/(account)/account/.../layout.tsx`),右下角气泡;点开浮层聊天窗(shadcn 风格)。
- 进入时 `GET /api/account/support/conversation` 载历史。
- 发送:fetch `POST /api/account/support/chat`,用 **ReadableStream 读 SSE**,按 `delta` 逐字渲染、`tool` 显示「正在查询…」状态条、`done` 收尾。
- 升级工单:收到含 ticketId 的回复时,渲染一张卡片带「查看工单」跳 `/account/tickets`。
- `SUPPORT_AGENT_ENABLED` 关时不渲染气泡(前端通过 `/conversation` 探活或配置接口判断)。
- 客户端 fetch 封装 `user-api.ts` 加对应方法。

### i18n

气泡/标题/输入框 placeholder/工具状态/兜底文案/升级卡片,9 语言(zh-CN 源 + 同步 8 语言),挂合适命名空间(如 `portalApp.support`)。

## 安全 / 边界

- **数据隔离**:`customerId` 只从 JWT 取,工具 schema 不含 id;会话归属强校验。
- **脱敏**:订阅/订单返回模型前删密钥类字段(`backingKeyValue` 等)。
- **防失控**:工具循环 ≤ `MAX_TOOL_ITERS`;历史/工具结果体积截断;每客户对 `chat` 端点限流(防刷爆模型额度)。
- **写操作最小面**:仅 `create_support_ticket` 一个写工具,其余只读。
- **降级**:模型/网络/解析失败一律兜底为友好文案 + 转人工建议,不抛 500 给前端。
- **成本**:历史窗口 + 工具结果截断控制 token;`SUPPORT_AGENT_ENABLED` 总开关可一键停。

## 测试

- 每个工具单测:数据隔离(传入他人 id 无效,只认 ctx.customerId)、脱敏字段确实被删。
- agent 循环单测:mock LLM,覆盖「直接回答」「调一次工具再答」「升级建工单」「超轮数兜底」「工具解析失败降级」。
- `chat` SSE 端点集成测试:事件序列 delta→tool→done;归属 403。
- 前端组件测试:流式渲染、工具状态、升级卡片、断流兜底。

## Phase 2(本次不做,登记)

- 后台 `/console` 加「机器人会话回看」页:管理员查看 `SupportConversation`,看 bot 答得对不对、哪些升级了。
- 命中率/升级率统计、坏案例标注回流改 prompt。
