/** 客服 agent 流式吐给前端的 SSE 事件。 */
export type SseEvent =
  /** 会话已确定(尽早告知前端,便于续聊与归属)。 */
  | { type: "meta"; conversationId: string }
  /** 助手文本增量。 */
  | { type: "delta"; text: string }
  /** 正在调用某工具(前端显示"正在查询你的订阅…")。 */
  | { type: "tool"; name: string }
  /** 本轮结束。ticketId 非空表示已升级转人工。 */
  | { type: "done"; conversationId: string; ticketId: string | null }
  /** 出错(已含兜底文案,前端直接展示)。 */
  | { type: "error"; message: string };
