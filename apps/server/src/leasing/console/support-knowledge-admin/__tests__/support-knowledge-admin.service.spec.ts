/**
 * support-knowledge-admin.service.spec.ts — 工单提炼 + 去重合并
 *
 * 覆盖:
 *   1. 禁用 → 抛错
 *   2. 工单不存在 → not_found
 *   3. 模型输出无法解析 → parse_failed
 *   4. worthSaving=false → skipped
 *   5. 无同类 → draft
 *   6. 有同类 → merge_suggested(走合并 LLM + createMergeSuggestion)
 *   7. parseDistilled:围栏/缺字段/正常
 */
import { describe, it, expect, vi } from "vitest";

import { SupportKnowledgeAdminService } from "../support-knowledge-admin.service";
import { parseDistilled } from "../distill.prompt";

function deps(llmEnabled = true) {
  const prisma = { ticket: { findUnique: vi.fn() } };
  const llm = { enabled: llmEnabled, complete: vi.fn() };
  const knowledge = {
    findSimilar: vi.fn(),
    createDraft: vi.fn().mockResolvedValue({ id: "draft1" }),
    createMergeSuggestion: vi.fn().mockResolvedValue({ id: "sug1" }),
  };
  const svc = new SupportKnowledgeAdminService(
    prisma as any,
    llm as any,
    knowledge as any,
  );
  return { svc, prisma, llm, knowledge };
}

const TICKET = {
  subject: "登录不了",
  messages: [
    { authorType: "CUSTOMER", body: "我登录一直转圈" },
    { authorType: "ADMIN", body: "请清缓存后重试" },
  ],
};

describe("SupportKnowledgeAdminService.distillTickets", () => {
  it("禁用 → 抛错", async () => {
    const { svc } = deps(false);
    await expect(svc.distillTickets(["t1"])).rejects.toThrow();
  });

  it("工单不存在 → not_found", async () => {
    const { svc, prisma } = deps();
    prisma.ticket.findUnique.mockResolvedValue(null);
    const out = await svc.distillTickets(["t1"]);
    expect(out.results[0].outcome).toBe("not_found");
  });

  it("解析失败 → parse_failed", async () => {
    const { svc, prisma, llm } = deps();
    prisma.ticket.findUnique.mockResolvedValue(TICKET);
    llm.complete.mockResolvedValue("我不知道该输出什么");
    const out = await svc.distillTickets(["t1"]);
    expect(out.results[0].outcome).toBe("parse_failed");
  });

  it("worthSaving=false → skipped", async () => {
    const { svc, prisma, llm } = deps();
    prisma.ticket.findUnique.mockResolvedValue(TICKET);
    llm.complete.mockResolvedValue(
      JSON.stringify({ question: "q", answer: "a", category: "", worthSaving: false }),
    );
    const out = await svc.distillTickets(["t1"]);
    expect(out.results[0].outcome).toBe("skipped");
  });

  it("无同类 → draft", async () => {
    const { svc, prisma, llm, knowledge } = deps();
    prisma.ticket.findUnique.mockResolvedValue(TICKET);
    llm.complete.mockResolvedValue(
      JSON.stringify({ question: "登录转圈怎么办", answer: "清缓存", category: "登录", worthSaving: true }),
    );
    knowledge.findSimilar.mockResolvedValue(null);
    const out = await svc.distillTickets(["t1"]);
    expect(out.results[0].outcome).toBe("draft");
    expect(knowledge.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ question: "登录转圈怎么办", sourceTicketId: "t1" }),
    );
  });

  it("有同类 → merge_suggested(合并 LLM + createMergeSuggestion)", async () => {
    const { svc, prisma, llm, knowledge } = deps();
    prisma.ticket.findUnique.mockResolvedValue(TICKET);
    llm.complete
      .mockResolvedValueOnce(
        JSON.stringify({ question: "登录转圈", answer: "清缓存", category: "登录", worthSaving: true }),
      )
      .mockResolvedValueOnce("合并后的更完善答案");
    knowledge.findSimilar.mockResolvedValue({ id: "exist1", question: "登录问题", answer: "旧答案" });
    const out = await svc.distillTickets(["t1"]);
    expect(out.results[0].outcome).toBe("merge_suggested");
    expect(knowledge.createMergeSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({ mergeTargetId: "exist1", answer: "合并后的更完善答案" }),
    );
  });

  it("批量去重 + 上限 20", async () => {
    const { svc, prisma, llm, knowledge } = deps();
    prisma.ticket.findUnique.mockResolvedValue(null);
    llm.complete.mockResolvedValue("{}");
    knowledge.findSimilar.mockResolvedValue(null);
    const ids = Array.from({ length: 30 }, (_, i) => `t${i}`);
    const out = await svc.distillTickets(ids);
    expect(out.processed).toBe(20);
  });
});

describe("parseDistilled", () => {
  it("正常 JSON", () => {
    const r = parseDistilled('{"question":"q","answer":"a","category":"登录","worthSaving":true}');
    expect(r).toEqual({ question: "q", answer: "a", category: "登录", worthSaving: true });
  });

  it("容忍代码块围栏 + 前后文字", () => {
    const r = parseDistilled('好的:\n```json\n{"question":"q","answer":"a","category":""}\n```');
    expect(r?.question).toBe("q");
    expect(r?.category).toBeNull();
    expect(r?.worthSaving).toBe(true); // 缺省视为 true
  });

  it("缺 question/answer → null", () => {
    expect(parseDistilled('{"answer":"a"}')).toBeNull();
    expect(parseDistilled("不是 JSON")).toBeNull();
    expect(parseDistilled("")).toBeNull();
  });
});
