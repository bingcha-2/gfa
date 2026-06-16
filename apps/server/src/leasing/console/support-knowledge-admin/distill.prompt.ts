import { ChatMessage } from "../../account/support-agent/llm/llm.types";

export interface TicketForDistill {
  subject: string;
  messages: { authorType: string; body: string }[];
}

/** 提炼结果(从模型 JSON 解析)。 */
export interface DistilledResult {
  question: string;
  answer: string;
  category: string | null;
  worthSaving: boolean;
}

/** 工单 → 提炼一条通用知识(去隐私、泛化)。模型须只输出一个 JSON 对象。 */
export function buildDistillMessages(ticket: TicketForDistill): ChatMessage[] {
  const transcript = ticket.messages
    .map((m) => `${m.authorType === "ADMIN" ? "客服" : "客户"}: ${m.body}`)
    .join("\n");

  const system = `你是知识库整理助手。下面给你一条已处理的客服工单(标题 + 完整对话),请把它提炼成一条「通用、可复用」的客服知识。

要求:
- 去掉一切客户专属/隐私信息(邮箱、订单号、密钥、昵称、金额等具体值),写成对所有人都适用的通用问题与解法。
- question:一句话概括问题,像 FAQ 标题。
- answer:清晰简洁的解决结论/步骤。
- category:简短分类(如"登录""付费""订阅""接入"),没有合适的留空字符串。
- worthSaving:如果这条工单没有可复用价值(纯闲聊、无结论、重复确认),设为 false。

只输出一个 JSON 对象,不要任何额外文字、不要代码块围栏:
{"question":"...","answer":"...","category":"...","worthSaving":true}`;

  const user = `工单标题:${ticket.subject}\n\n对话记录:\n${transcript}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** 把已有答案与若干新答案合并成一条更完善的答案。模型只输出答案正文。 */
export function buildMergeMessages(
  question: string,
  answers: string[],
): ChatMessage[] {
  const system = `你是知识库整理助手。同一主题下有多条答案(可能来自不同案例),请合并成一条更完善、条理清晰、不重复的答案。只输出合并后的答案正文,不要任何额外说明、不要代码块围栏。`;
  const body = answers
    .map((a, i) => `答案${i + 1}:\n${a}`)
    .join("\n\n");
  const user = `问题:${question}\n\n${body}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * 从模型输出里稳妥地解析提炼 JSON:
 * 容忍代码块围栏 / 前后多余文字 —— 截取第一个 { 到最后一个 }。
 * 解析失败或字段不全返回 null。
 */
export function parseDistilled(raw: string): DistilledResult | null {
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;

  const question = typeof o.question === "string" ? o.question.trim() : "";
  const answer = typeof o.answer === "string" ? o.answer.trim() : "";
  if (!question || !answer) return null;

  const category =
    typeof o.category === "string" && o.category.trim()
      ? o.category.trim()
      : null;
  // 默认值得保存;只有显式 false 才跳过。
  const worthSaving = o.worthSaving !== false;

  return { question, answer, category, worthSaving };
}
