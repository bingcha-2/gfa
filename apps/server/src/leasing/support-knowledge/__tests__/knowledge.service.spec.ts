/**
 * knowledge.service.spec.ts — 知识检索读侧
 *
 * 覆盖:
 *   1. searchTitles:空库 → []
 *   2. searchTitles:小库(≤150)→ 直接返回全部标题
 *   3. searchTitles:大库(>150)→ 关键词粗筛打分 top-N
 *   4. getAnswer:未发布 / 不存在 → null,不自增
 *   5. getAnswer:已发布 → 返回解法且 usageCount +1
 *   6. tokenize:ASCII 词 + 中文 bigram
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { KnowledgeService, tokenize } from "../knowledge.service";

function makePrisma() {
  const prisma: any = {
    knowledgeEntry: {
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return prisma;
}

describe("KnowledgeService.searchTitles", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: KnowledgeService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = new KnowledgeService(prisma as any);
  });

  it("空库返回 []", async () => {
    prisma.knowledgeEntry.count.mockResolvedValue(0);
    expect(await svc.searchTitles("怎么登录")).toEqual([]);
    expect(prisma.knowledgeEntry.findMany).not.toHaveBeenCalled();
  });

  it("小库直接返回全部标题", async () => {
    prisma.knowledgeEntry.count.mockResolvedValue(3);
    const rows = [
      { id: "a", question: "怎么登录" },
      { id: "b", question: "怎么付费" },
      { id: "c", question: "怎么接入" },
    ];
    prisma.knowledgeEntry.findMany.mockResolvedValue(rows);
    const out = await svc.searchTitles("登录");
    expect(out).toEqual(rows);
    // 小库路径用 orderBy usageCount/updatedAt
    expect(prisma.knowledgeEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: expect.anything() }),
    );
  });

  it("大库走关键词粗筛,命中优先", async () => {
    prisma.knowledgeEntry.count.mockResolvedValue(200);
    const rows = [
      { id: "1", question: "订阅未激活怎么办" },
      { id: "2", question: "如何修改昵称" },
      { id: "3", question: "套餐没生效是什么原因" },
    ];
    prisma.knowledgeEntry.findMany.mockResolvedValue(rows);
    const out = await svc.searchTitles("套餐没生效");
    // "套餐没生效" 应命中 id=3,不含无关的「修改昵称」
    expect(out.map((r) => r.id)).toContain("3");
    expect(out.map((r) => r.id)).not.toContain("2");
  });
});

describe("KnowledgeService.getAnswer", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: KnowledgeService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = new KnowledgeService(prisma as any);
  });

  it("不存在 → null,不自增", async () => {
    prisma.knowledgeEntry.findUnique.mockResolvedValue(null);
    expect(await svc.getAnswer("x")).toBeNull();
    expect(prisma.knowledgeEntry.update).not.toHaveBeenCalled();
  });

  it("未发布 → null,不自增", async () => {
    prisma.knowledgeEntry.findUnique.mockResolvedValue({
      id: "x", question: "q", answer: "a", status: "DRAFT",
    });
    expect(await svc.getAnswer("x")).toBeNull();
    expect(prisma.knowledgeEntry.update).not.toHaveBeenCalled();
  });

  it("已发布 → 返回解法且 usageCount +1", async () => {
    prisma.knowledgeEntry.findUnique.mockResolvedValue({
      id: "x", question: "怎么登录", answer: "点右上角登录", status: "PUBLISHED",
    });
    prisma.knowledgeEntry.update.mockResolvedValue({});
    const out = await svc.getAnswer("x");
    expect(out).toEqual({ id: "x", question: "怎么登录", answer: "点右上角登录" });
    expect(prisma.knowledgeEntry.update).toHaveBeenCalledWith({
      where: { id: "x" },
      data: { usageCount: { increment: 1 } },
    });
  });
});

describe("KnowledgeService 写侧 / 去重合并", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: KnowledgeService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = new KnowledgeService(prisma as any);
  });

  it("findSimilar:有同类(共享≥2检索词)→ 返回;无 → null", async () => {
    prisma.knowledgeEntry.findMany.mockResolvedValue([
      { id: "1", question: "订阅未激活怎么办", answer: "a1" },
      { id: "2", question: "如何修改昵称", answer: "a2" },
    ]);
    const hit = await svc.findSimilar("订阅未激活");
    expect(hit?.id).toBe("1");

    const miss = await svc.findSimilar("发票怎么开");
    expect(miss).toBeNull();
  });

  it("createManual:发布 → PUBLISHED + createdBy ADMIN;不发布 → DRAFT", async () => {
    prisma.knowledgeEntry.create.mockResolvedValue(rec({ id: "m", status: "PUBLISHED" }));
    await svc.createManual({ question: "q", answer: "a", category: "登录" }, true);
    expect(prisma.knowledgeEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PUBLISHED", createdBy: "ADMIN" }),
      }),
    );
    await svc.createManual({ question: "q2", answer: "a2" }, false);
    expect(prisma.knowledgeEntry.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "DRAFT" }) }),
    );
  });

  it("createDraft / createMergeSuggestion 写入正确 status", async () => {
    prisma.knowledgeEntry.create.mockResolvedValue({ id: "new" });
    await svc.createDraft({ question: "q", answer: "a", sourceTicketId: "t1" });
    expect(prisma.knowledgeEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DRAFT", sourceTicketId: "t1" }),
      }),
    );

    await svc.createMergeSuggestion({
      question: "q", answer: "a", mergeTargetId: "tgt",
    });
    expect(prisma.knowledgeEntry.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "MERGE_SUGGESTED", mergeTargetId: "tgt" }),
      }),
    );
  });

  it("publish 普通草稿 → PUBLISHED", async () => {
    prisma.knowledgeEntry.findUnique.mockResolvedValue({
      id: "d", status: "DRAFT", mergeTargetId: null,
    });
    prisma.knowledgeEntry.update.mockResolvedValue(rec({ id: "d", status: "PUBLISHED" }));
    const out = await svc.publish("d");
    expect(prisma.knowledgeEntry.update).toHaveBeenCalledWith({
      where: { id: "d" }, data: { status: "PUBLISHED" },
    });
    expect(out?.status).toBe("PUBLISHED");
  });

  it("publish 合并建议 → 更新目标条目并归档建议", async () => {
    prisma.knowledgeEntry.findUnique.mockResolvedValue({
      id: "sug", status: "MERGE_SUGGESTED", mergeTargetId: "tgt",
      question: "合并后问题", answer: "合并后答案", category: "登录",
    });
    prisma.knowledgeEntry.update
      .mockResolvedValueOnce(rec({ id: "tgt", question: "合并后问题", answer: "合并后答案", status: "PUBLISHED" }))
      .mockResolvedValueOnce(rec({ id: "sug", status: "ARCHIVED" }));
    const out = await svc.publish("sug");
    // 第一次 update 写目标,第二次归档建议
    expect(prisma.knowledgeEntry.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: "tgt" },
      data: expect.objectContaining({ answer: "合并后答案", status: "PUBLISHED" }),
    }));
    expect(prisma.knowledgeEntry.update).toHaveBeenNthCalledWith(2, {
      where: { id: "sug" }, data: { status: "ARCHIVED" },
    });
    expect(out?.id).toBe("tgt");
  });

  it("publish 找不到 → null", async () => {
    prisma.knowledgeEntry.findUnique.mockResolvedValue(null);
    expect(await svc.publish("x")).toBeNull();
  });

  it("applyManualMerge:主条目发布 + 其余归档", async () => {
    prisma.knowledgeEntry.update
      .mockResolvedValueOnce(rec({ id: "p", question: "Q", answer: "A", status: "PUBLISHED" }))
      .mockResolvedValueOnce(rec({ id: "o1", status: "ARCHIVED" }));
    const out = await svc.applyManualMerge("p", ["o1"], { question: "Q", answer: "A" });
    expect(out.id).toBe("p");
    expect(out.status).toBe("PUBLISHED");
    expect(prisma.knowledgeEntry.update).toHaveBeenNthCalledWith(2, {
      where: { id: "o1" }, data: { status: "ARCHIVED" },
    });
  });
});

function rec(over: Record<string, unknown>) {
  return {
    id: "x", question: "q", answer: "a", category: null, status: "DRAFT",
    mergeTargetId: null, sourceTicketId: null, usageCount: 0, createdBy: "AI",
    createdAt: new Date("2026-06-15T00:00:00Z"), updatedAt: new Date("2026-06-15T00:00:00Z"),
    ...over,
  };
}

describe("KnowledgeService 语义检索(embedding)", () => {
  function withEmbed(qvec: number[]) {
    return { enabled: true, embedOne: vi.fn().mockResolvedValue(qvec) };
  }

  it("启用 embedding 时按余弦排序,过滤不相关", async () => {
    const prisma = makePrisma();
    const embed = withEmbed([1, 0]);
    const svc = new KnowledgeService(prisma as any, embed as any);

    prisma.knowledgeEntry.count.mockResolvedValue(2);
    prisma.knowledgeEntry.findMany.mockResolvedValue([
      { id: "a", question: "登录问题", embedding: JSON.stringify([1, 0]) }, // 余弦1
      { id: "b", question: "无关问题", embedding: JSON.stringify([0, 1]) }, // 余弦0 → 丢
    ]);

    const out = await svc.searchTitles("怎么登录");
    expect(out.map((r) => r.id)).toEqual(["a"]);
    expect(embed.embedOne).toHaveBeenCalledWith("怎么登录");
  });

  it("向量结果为空 → 回退关键词路径", async () => {
    const prisma = makePrisma();
    const embed = withEmbed([1, 0]);
    const svc = new KnowledgeService(prisma as any, embed as any);

    prisma.knowledgeEntry.count.mockResolvedValue(2);
    // 第一次 findMany(向量,where embedding!=null)无向量化条目 → null → 回退
    prisma.knowledgeEntry.findMany
      .mockResolvedValueOnce([]) // vectorSearch 取不到
      .mockResolvedValueOnce([{ id: "k", question: "关键词命中" }]); // 关键词路径(小库全给)
    const out = await svc.searchTitles("命中");
    expect(out).toEqual([{ id: "k", question: "关键词命中" }]);
  });

  it("发布时计算并存 embedding", async () => {
    const prisma = makePrisma();
    const embed = withEmbed([0.1, 0.2, 0.3]);
    const svc = new KnowledgeService(prisma as any, embed as any);

    prisma.knowledgeEntry.findUnique.mockResolvedValue({
      id: "d", status: "DRAFT", mergeTargetId: null, question: "怎么登录",
    });
    prisma.knowledgeEntry.update.mockResolvedValue(rec({ id: "d", status: "PUBLISHED" }));
    await svc.publish("d");
    expect(prisma.knowledgeEntry.update).toHaveBeenCalledWith({
      where: { id: "d" },
      data: { status: "PUBLISHED", embedding: JSON.stringify([0.1, 0.2, 0.3]) },
    });
  });
});

describe("tokenize", () => {
  it("ASCII 词(≥2)+ 中文 bigram", () => {
    const t = tokenize("API 登录失败");
    expect(t).toContain("api");
    expect(t).toContain("登录");
    expect(t).toContain("录失");
  });
});
