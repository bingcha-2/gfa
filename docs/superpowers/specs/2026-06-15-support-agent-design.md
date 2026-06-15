# 客户端客服 Agent + 工单知识飞轮 设计

- 日期:2026-06-15
- 状态:待用户评审 → 实现

## 目标

在客户端(`account` 侧)右下角加一个**悬浮客服气泡**,点开是**全自动实时对话客服机器人**。

**核心难点 / 关键设计**:**我们没有现成知识库**。真正的知识在历史工单里(用户问了什么、人工怎么解决的)。所以本设计的核心不是"接个大模型",而是一套**知识飞轮**:bot 上线时几乎什么都不会 → 答不了就转人工建工单 → 人工解决后,系统自动把「问题 + 解法」提炼成知识 → 下次同类问题 bot 自己能答。**越用越聪明,运营无需手写文档。**

bot 能力:
1. **查本人信息**——读当前登录客户的资料/订阅/订单。
2. **查知识库**——检索由工单提炼出的已发布知识,基于它作答(不编造)。
3. **创建/升级工单**——查不到/客户要人工时,自动转工单接入现有体系。

**不做**:任何高风险写操作(改密码、重发密钥、重启租约)。v1 只读 + 建工单。

## 决策(已确认)

| 维度 | 决定 |
|---|---|
| 工作模式 | 全自动实时对话客服 |
| **知识来源** | **从工单提炼的知识库(知识飞轮)**,非手写 FAQ |
| **知识入库** | AI 提炼成**草稿**,后台**人工审核**通过才生效 |
| **知识检索(v1)** | 关键词 + AI 选标题,**不依赖 embedding**;Phase 2 升级语义检索 |
| 模型渠道 | 国内供应商,OpenAI 兼容接口,env 切换(DeepSeek/千问/豆包) |
| Agent 框架 | 不用框架,`openai` SDK + 手写 tool-calling 循环 |
| 实时传输 | SSE 流式(NestJS 原生) |
| 入口 | 客户端右下角悬浮气泡 |
| 持久化 | 新增 Prisma `SupportConversation`/`SupportMessage`/`KnowledgeEntry` |
| 提炼任务 | 复用现有 **BullMQ** 队列后台跑 |
| 生产库 | **SQLite**(故检索用内存余弦/关键词,不上 pgvector) |

## 知识飞轮(核心机制)

```
客户提问
  ↓
bot 调 search_knowledge,在「已发布知识」里找同类已解决问题
  ↓
命中 → 基于知识作答(并记一次 usageCount)
查不到 / 客户要人工 / 涉及退款·账号安全
  ↓
bot 调 create_support_ticket 转人工(带上对话上下文)
  ↓
你 / 客服在现有工单系统回复、解决、关闭
  ↓
[工单关闭] 触发 BullMQ 提炼任务:
   LLM 读工单全文 → 提炼 { 问题, 通用解法, 分类, 是否值得入库 }
   去隐私 / 去客户专属信息 / 写成通用版
  ↓
生成「草稿」知识条目(status=DRAFT)
  ↓
[后台知识审核页] 你一键 通过/编辑/删除
  ↓
status=PUBLISHED → 下次同类问题 bot 自己能答
```

**冷启动**:上线初期知识库空,bot 主要在"接待 + 转人工"——这正是"慢慢收集工单",但每个解决的工单都自动变成 bot 的教材。跑几周后常见问题 bot 基本能接住。
**可选加速(Phase 2)**:已有历史已解决工单,可批量跑提炼,一次性生成一版初始草稿库待审。

## 后端

### 新模块 `apps/server/src/leasing/account/support-agent/`(客户端)

```
support-agent/
  support-agent.module.ts
  support.controller.ts          # CustomerJwtGuard 客户端端点(SSE)
  support-agent.service.ts       # agent 编排 + 工具循环 + 流式
  conversation.service.ts        # 会话/消息持久化
  llm/llm.client.ts              # openai SDK 封装,指向 env 兼容端点
  retrieval/knowledge-retriever.ts  # 检索接口(v1 关键词,Phase2 换 embedding)
  tools/                         # 见下
  prompt/system-prompt.ts
```

### 新模块 `apps/server/src/leasing/support-knowledge/`(知识库 + 提炼)

```
support-knowledge/
  knowledge.service.ts           # KnowledgeEntry CRUD + 发布/检索
  distill/
    distill.processor.ts         # BullMQ 消费者:工单 → 草稿知识
    distill.producer.ts          # 工单关闭时入队
    distill.prompt.ts            # 提炼提示(去隐私/泛化/判断是否值得存)
```

### 新模块 `apps/server/src/leasing/console/support-knowledge-admin/`(后台审核)

```
support-knowledge-admin/
  controller.ts                  # ConsoleJwtGuard,知识审核 CRUD
  service.ts
```

### LLM client(`llm/llm.client.ts`)

- 新增依赖 `openai`。配置(换供应商只改三值):
  ```
  SUPPORT_LLM_BASE_URL    # 如 https://api.deepseek.com
  SUPPORT_LLM_API_KEY
  SUPPORT_LLM_MODEL       # deepseek-chat / qwen-plus / 豆包接入点ID
  SUPPORT_LLM_MAX_TOOL_ITERS=6
  SUPPORT_AGENT_ENABLED   # 总开关;未配置则关闭并隐藏前端气泡
  ```
- 标准 `chat.completions.create({ model, messages, tools, stream: true })`。

### Agent 工具集(`tools/`)

每工具一文件,`{ name, description, parameters(JSON schema), handler(args, ctx) }`。**`ctx.customerId` 由服务端从 JWT 注入,schema 不暴露 id,绝不信任模型传入的 id。**

| 工具 | 入参 | 调用 | 备注 |
|---|---|---|---|
| `get_my_profile` | 无 | `CustomerAuthService.getProfile(ctx.customerId)` | 资料+余额 |
| `get_my_subscriptions` | 无 | `BillingService.listSubscriptions` | 脱敏:删 `backingKeyValue` 等密钥 |
| `get_my_orders` | `{page?,pageSize?}` | `BillingService.listOrders` | 默认首页 |
| `search_knowledge` | `{query}` | `KnowledgeService.search(query)` | 见检索设计;命中条目 `usageCount++` |
| `create_support_ticket` | `{subject,body}` | `TicketService.create(ctx.customerId,...)` | 升级转人工;回 ticketId;同时把会话 `status=ESCALATED`、`ticketId` 落库 |

返回模型前统一**脱敏 + 体积截断**。

### 知识检索(`retrieval/knowledge-retriever.ts`)—— 接口稳定,实现可换

- **v1(零依赖)**:`search(query)` = 用 LLM 给出的关键词对 `KnowledgeEntry.question/category` 做 `LIKE` 预筛 + 简单评分,取 top-K(默认 5)已发布条目返回 `{id,question,answer}`。知识库很小时直接返回全部已发布。中文不依赖分词扩展,够用。
- **Phase 2(语义升级)**:同一 `search()` 接口内部换成 embedding 余弦检索——把已发布条目 embedding 缓存内存,incoming query embedding 后暴力余弦 top-K。SQLite 下数百~数千条 Node 内算 <10ms,**不引 pgvector**。embedding 走**单独配置**的供应商(`SUPPORT_EMBED_BASE_URL/KEY/MODEL`),因 DeepSeek 无 embedding,可指向千问/豆包/OpenAI。工具接口与前端不变。

### Agent 编排(`support-agent.service.ts`)

`async *run(ctx, conversationId, userText)`——async generator,逐段 yield SSE:

1. 落库用户消息,载最近 N 条历史(防超长)。
2. `messages = [systemPrompt, ...history, userText]`。
3. 工具循环(≤ `MAX_TOOL_ITERS`):调 LLM(stream),文本 → `yield {type:'delta'}`;有 `tool_calls` → `yield {type:'tool',name}`(前端显示"正在查询你的订阅…"),执行(注入 ctx.customerId),push 回 messages,`continue`;无 tool_calls → 终答 break。
4. 落库 assistant 消息,`yield {type:'done',conversationId}`。
5. **兜底**:LLM/网络/工具解析失败 / 超轮数 → `yield {type:'error'}` + 友好文案 + 主动建议转人工;豆包等 function-calling 不稳时降级为纯文本,不崩、不抛 500。

### 接口

```
# 客户端 (CustomerJwtGuard)
POST /api/account/support/chat         # body {conversationId?, message} → SSE: delta|tool|done|error
GET  /api/account/support/conversation # 载当前客户最近会话(重开续聊)

# 后台知识审核 (ConsoleJwtGuard)
GET    /api/console/support-knowledge          # 列表(按 status 过滤:DRAFT/PUBLISHED)
PATCH  /api/console/support-knowledge/:id       # 编辑 question/answer/category
POST   /api/console/support-knowledge/:id/publish   # 草稿→发布
DELETE /api/console/support-knowledge/:id       # 删除/归档
```

`customerId` 一律来自 `@CurrentCustomer()`;会话归属强校验(不符 → 403)。

### 数据模型(Prisma 新增)

```prisma
model SupportConversation {
  id         String           @id @default(cuid())
  customerId String
  status     String           @default("OPEN")   // OPEN | ESCALATED | CLOSED
  ticketId   String?
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
  content        String
  toolCalls      String?             // assistant 发起的 tool_calls(JSON)
  createdAt      DateTime            @default(now())
  conversation   SupportConversation @relation(fields: [conversationId], references: [id])
  @@index([conversationId, createdAt])
}

model KnowledgeEntry {
  id             String   @id @default(cuid())
  question       String                       // 归一化问题
  answer         String                       // 通用解法
  category       String?
  status         String   @default("DRAFT")   // DRAFT | PUBLISHED | ARCHIVED
  sourceTicketId String?                      // 来源工单
  usageCount     Int      @default(0)         // 被 bot 引用次数
  createdBy      String   @default("AI")      // AI | <adminId>
  embedding      String?                      // 预留:Phase2 存 float[] JSON
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@index([status])
}
```

`Customer` 加反向关系 `supportConversations SupportConversation[]`。`prisma migrate` 建表。

### 提炼任务(BullMQ)

- **触发**:工单状态变 `CLOSED`(在 `TicketAdminService` 改状态处入队 `distill` 任务,带 ticketId)。
- **消费**:`distill.processor` 读工单全文 → LLM 提炼 `{question, answer, category, worthSaving}`(去隐私、泛化、判断是否值得入库)→ `worthSaving` 才建 `KnowledgeEntry(status=DRAFT, sourceTicketId)`。
- **去重**:入库前与现有 `PUBLISHED` 条目做 question 关键词比对,高度相似则标注"疑似重复"留审核,不直接丢。

### 系统提示要点(`prompt/system-prompt.ts`)

- 人设:GFA 中文客服,友好简洁。
- 范围:只答本产品(账号租赁/订阅/付费/接入);无关问题礼貌拒答。
- **必须先 `search_knowledge` 再答事实;查不到就老实说不确定并转人工,绝不编造。**
- 涉订阅/订单/余额必须先查对应工具。
- 升级:查不到 / 退款 / 账号安全 / 客户明确要人工 → `create_support_ticket` 转人工并告知工单号。
- 数据隔离:只谈当前客户自己的数据。

## 前端

### 悬浮组件 `apps/web/src/components/account/support-chat-widget.tsx`

挂 account 布局,右下角气泡 → shadcn 聊天浮层。进入 `GET /conversation` 载历史;发送用 fetch + ReadableStream 读 SSE,按 `delta` 逐字渲染、`tool` 显示状态条、`done` 收尾;命中升级时渲染带 ticketId 的"查看工单"卡片跳 `/account/tickets`。`SUPPORT_AGENT_ENABLED` 关时不渲染。`user-api.ts` 加方法。

### 后台知识审核页 `/console/.../support-knowledge`

- 侧边栏(`console-sidebar.tsx`「系统」组)加入口,权限 ADMIN/OPERATIONS。
- 列表:草稿/已发布切换;每条显示 问题/解法/分类/来源工单/usageCount;操作:编辑、通过(发布)、删除。
- 复用现有 console 表格组件(TanStack Table)。

### i18n

气泡/聊天 UI/工具状态/兜底/升级卡片,9 语言(zh-CN 源 + 同步 8 语言),命名空间 `portalApp.support`。后台审核页中文即可(沿用 console 现状)。

## 安全 / 边界

- **数据隔离**:customerId 只从 JWT 取;会话归属强校验。
- **隐私**:提炼入库时**去客户专属信息**(邮箱/单号/密钥),知识只存通用解法;订阅/订单返回模型前删密钥字段。
- **审核闸**:AI 提炼只进草稿,人工通过才被 bot 使用——防错误知识误导客户。
- **防失控**:工具循环 ≤ MAX_TOOL_ITERS;历史/工具结果体积截断;`chat` 端点每客户限流。
- **写面最小**:仅 `create_support_ticket` 一个写工具。
- **降级**:任何失败兜底为友好文案 + 转人工,不抛 500。
- **总开关**:`SUPPORT_AGENT_ENABLED` 可一键停 bot。

## 测试

- 工具单测:数据隔离(他人 id 无效)、脱敏字段被删。
- agent 循环:mock LLM,覆盖 直接答 / 查一次知识再答 / 升级建工单 / 超轮兜底 / 工具解析失败降级。
- 提炼任务:mock LLM,覆盖 worthSaving 真假、去隐私、疑似重复标注。
- 检索:关键词命中、空库返回全部、usageCount 自增。
- SSE 端点集成:事件序列、归属 403。
- 知识审核端点:草稿→发布、删除、权限。
- 前端:流式渲染、工具状态、升级卡片、断流兜底;审核页增删改。

## 实现顺序(建议分期)

- **P1 闭环最小可用**:Prisma 三模型 + LLM client + agent 循环 + 4 个只读/建单工具 + `search_knowledge`(关键词) + SSE 接口 + 悬浮气泡前端。此时 bot 能聊、能查本人信息、查不到就转人工。
- **P2 知识飞轮**:工单关闭触发 BullMQ 提炼 → 草稿 + 后台审核页。此后知识自动积累、bot 越用越能答。
- **P3 增强(可选)**:历史工单批量提炼冷启动;embedding 语义检索;运营看板(deflection 率、高频未答问题);后台回看 bot 会话。

(P1+P2 即完整飞轮;P3 为优化。)
