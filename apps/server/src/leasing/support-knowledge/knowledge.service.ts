import { Injectable } from "@nestjs/common";

import { PrismaService } from "../../shared/prisma/prisma.service";
import {
  cosine,
  EmbeddingClient,
} from "../account/support-agent/llm/embedding.client";

/** 检索返回的知识标题(给模型挑)。 */
export interface KnowledgeTitle {
  id: string;
  question: string;
}

/** 取回的完整知识条目。 */
export interface KnowledgeAnswer {
  id: string;
  question: string;
  answer: string;
}

/** 知识库很小时直接把全部标题给模型(标题短、省 token)。 */
const INLINE_LIMIT = 150;
/** 超过 INLINE_LIMIT 时关键词粗筛返回的候选上限。 */
const MAX_CANDIDATES = 50;
/** 向量检索返回的候选上限。 */
const VECTOR_TOP_K = 8;
/** 低于此余弦视为不相关,丢弃。 */
const VECTOR_MIN_SCORE = 0.1;
/** 提炼去重:与现有条目共享 ≥ 此数量的检索词,判为同类(给出合并建议)。 */
const SIMILARITY_MIN_HITS = 2;

/** 提炼出的一条知识。 */
export interface DistilledEntryInput {
  question: string;
  answer: string;
  category?: string | null;
  sourceTicketId?: string | null;
}

/** 后台列表/详情用的完整条目。 */
export interface KnowledgeEntryRecord {
  id: string;
  question: string;
  answer: string;
  category: string | null;
  status: string;
  mergeTargetId: string | null;
  sourceTicketId: string | null;
  usageCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * KnowledgeService —— 知识飞轮的读侧。
 *
 * v1 检索策略(零检索基建,SQLite 即用):
 *   - 已发布条目 ≤ INLINE_LIMIT:直接返回全部标题,语义匹配交给模型本身。
 *   - 超过:关键词(ASCII 词 + 中文 bigram)粗筛打分,取 top-N 标题。
 * Phase 2 把 searchTitles 内部换成 embedding 余弦检索即可,签名不变。
 */
@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    // 可选:配齐 SUPPORT_EMBED_* 时启用语义检索;单测/未配置时为 undefined,走关键词。
    private readonly embed?: EmbeddingClient,
  ) {}

  /**
   * 「全塞」模式:返回全部已发布 Q&A,直接拼进系统提示词。
   * 适合小知识库;带上限防止上下文爆掉(超出则按 usageCount/最近更新取前 N 并截断)。
   */
  async listPublishedQA(
    limit = 300,
  ): Promise<{ question: string; answer: string; category: string | null }[]> {
    const rows = await this.prisma.knowledgeEntry.findMany({
      where: { status: "PUBLISHED" },
      orderBy: [{ usageCount: "desc" }, { updatedAt: "desc" }],
      take: limit,
      select: { question: true, answer: true, category: true },
    });
    return rows;
  }

  /** 返回候选知识标题清单,供模型按语义挑选。 */
  async searchTitles(query: string): Promise<KnowledgeTitle[]> {
    const total = await this.prisma.knowledgeEntry.count({
      where: { status: "PUBLISHED" },
    });

    if (total === 0) return [];

    // 语义检索(P3):有 embedding 配置且存在已向量化条目时优先;失败回退关键词。
    if (this.embed?.enabled) {
      const vector = await this.vectorSearch(query);
      if (vector && vector.length > 0) return vector;
    }

    if (total <= INLINE_LIMIT) {
      const rows = await this.prisma.knowledgeEntry.findMany({
        where: { status: "PUBLISHED" },
        orderBy: [{ usageCount: "desc" }, { updatedAt: "desc" }],
        select: { id: true, question: true },
      });
      return rows;
    }

    // 规模较大:加载标题(短)在内存里关键词打分。
    const rows = await this.prisma.knowledgeEntry.findMany({
      where: { status: "PUBLISHED" },
      select: { id: true, question: true },
    });
    const terms = tokenize(query);
    if (terms.length === 0) {
      return rows.slice(0, MAX_CANDIDATES);
    }
    const scored = rows
      .map((r) => ({ r, score: scoreQuestion(terms, r.question) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CANDIDATES)
      .map((s) => s.r);
    return scored;
  }

  /**
   * 取回某条已发布知识的完整解法,并把 usageCount +1。
   * 找不到 / 未发布 → null(让 agent 改走转人工)。
   */
  async getAnswer(id: string): Promise<KnowledgeAnswer | null> {
    const entry = await this.prisma.knowledgeEntry.findUnique({
      where: { id },
      select: { id: true, question: true, answer: true, status: true },
    });
    if (!entry || entry.status !== "PUBLISHED") return null;

    await this.prisma.knowledgeEntry.update({
      where: { id },
      data: { usageCount: { increment: 1 } },
    });

    return { id: entry.id, question: entry.question, answer: entry.answer };
  }

  /**
   * 语义检索:对已向量化的已发布条目算 query↔question 余弦,取 top-K。
   * 无可用 embedding / 异常 → 返回 null,调用方回退关键词。
   */
  private async vectorSearch(query: string): Promise<KnowledgeTitle[] | null> {
    try {
      const rows = await this.prisma.knowledgeEntry.findMany({
        where: { status: "PUBLISHED", embedding: { not: null } },
        select: { id: true, question: true, embedding: true },
      });
      if (rows.length === 0) return null;

      const qvec = await this.embed!.embedOne(query);
      if (qvec.length === 0) return null;

      const scored = rows
        .map((r) => {
          let vec: number[] = [];
          try {
            vec = JSON.parse(r.embedding as string);
          } catch {
            vec = [];
          }
          return { id: r.id, question: r.question, score: cosine(qvec, vec) };
        })
        .filter((s) => s.score >= VECTOR_MIN_SCORE)
        .sort((a, b) => b.score - a.score)
        .slice(0, VECTOR_TOP_K);

      return scored.map(({ id, question }) => ({ id, question }));
    } catch {
      return null;
    }
  }

  /** 计算一条知识的向量(JSON 字符串);未启用或失败返回 null。 */
  private async computeEmbedding(text: string): Promise<string | null> {
    if (!this.embed?.enabled) return null;
    try {
      const vec = await this.embed.embedOne(text);
      return vec.length ? JSON.stringify(vec) : null;
    } catch {
      return null;
    }
  }

  // ── 写侧(提炼 / 去重合并 / 后台管理)──────────────────────────────────────

  /**
   * 找现有同类条目(PUBLISHED / DRAFT,不含归档与待合并)。
   * 提炼新知识前调用:有同类则改走「合并建议」,避免一个主题堆多条。
   */
  async findSimilar(question: string): Promise<{ id: string; question: string; answer: string } | null> {
    const terms = tokenize(question);
    if (terms.length === 0) return null;

    const rows = await this.prisma.knowledgeEntry.findMany({
      where: { status: { in: ["PUBLISHED", "DRAFT"] } },
      select: { id: true, question: true, answer: true },
    });

    let best: { id: string; question: string; answer: string } | null = null;
    let bestScore = 0;
    for (const r of rows) {
      const score = scoreQuestion(terms, r.question);
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
    return bestScore >= SIMILARITY_MIN_HITS ? best : null;
  }

  /** 工作人员手动录入一条知识(可直接发布)。发布时计算 embedding。 */
  async createManual(
    input: { question: string; answer: string; category?: string | null },
    publish: boolean,
  ): Promise<KnowledgeEntryRecord> {
    const status = publish ? "PUBLISHED" : "DRAFT";
    const embedding = publish ? await this.computeEmbedding(input.question) : null;
    const row = await this.prisma.knowledgeEntry.create({
      data: {
        question: input.question,
        answer: input.answer,
        category: input.category ?? null,
        status,
        createdBy: "ADMIN",
        ...(embedding ? { embedding } : {}),
      },
    });
    return toRecord(row);
  }

  async createDraft(input: DistilledEntryInput): Promise<{ id: string }> {
    const row = await this.prisma.knowledgeEntry.create({
      data: {
        question: input.question,
        answer: input.answer,
        category: input.category ?? null,
        sourceTicketId: input.sourceTicketId ?? null,
        status: "DRAFT",
        createdBy: "AI",
      },
      select: { id: true },
    });
    return row;
  }

  async createMergeSuggestion(
    input: DistilledEntryInput & { mergeTargetId: string },
  ): Promise<{ id: string }> {
    const row = await this.prisma.knowledgeEntry.create({
      data: {
        question: input.question,
        answer: input.answer,
        category: input.category ?? null,
        sourceTicketId: input.sourceTicketId ?? null,
        mergeTargetId: input.mergeTargetId,
        status: "MERGE_SUGGESTED",
        createdBy: "AI",
      },
      select: { id: true },
    });
    return row;
  }

  /** 后台列表(可按 status 过滤),最近更新优先。 */
  async list(status?: string): Promise<KnowledgeEntryRecord[]> {
    const rows = await this.prisma.knowledgeEntry.findMany({
      where: status ? { status } : undefined,
      orderBy: { updatedAt: "desc" },
    });
    return rows.map(toRecord);
  }

  async getById(id: string): Promise<KnowledgeEntryRecord | null> {
    const row = await this.prisma.knowledgeEntry.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  async update(
    id: string,
    patch: { question?: string; answer?: string; category?: string | null },
  ): Promise<KnowledgeEntryRecord> {
    const row = await this.prisma.knowledgeEntry.update({
      where: { id },
      data: {
        ...(patch.question !== undefined ? { question: patch.question } : {}),
        ...(patch.answer !== undefined ? { answer: patch.answer } : {}),
        ...(patch.category !== undefined ? { category: patch.category } : {}),
      },
    });
    return toRecord(row);
  }

  /**
   * 发布:
   *   - 普通草稿 → PUBLISHED
   *   - 合并建议(MERGE_SUGGESTED)→ 把内容写回 mergeTargetId 指向的条目并归档本建议
   * 找不到 → null。
   */
  async publish(id: string): Promise<KnowledgeEntryRecord | null> {
    const entry = await this.prisma.knowledgeEntry.findUnique({ where: { id } });
    if (!entry) return null;

    if (entry.status === "MERGE_SUGGESTED" && entry.mergeTargetId) {
      const embedding = await this.computeEmbedding(entry.question);
      const [target] = await this.prisma.$transaction([
        this.prisma.knowledgeEntry.update({
          where: { id: entry.mergeTargetId },
          data: {
            question: entry.question,
            answer: entry.answer,
            category: entry.category,
            status: "PUBLISHED",
            ...(embedding ? { embedding } : {}),
          },
        }),
        this.prisma.knowledgeEntry.update({
          where: { id: entry.id },
          data: { status: "ARCHIVED" },
        }),
      ]);
      return toRecord(target);
    }

    const embedding = await this.computeEmbedding(entry.question);
    const row = await this.prisma.knowledgeEntry.update({
      where: { id },
      data: { status: "PUBLISHED", ...(embedding ? { embedding } : {}) },
    });
    return toRecord(row);
  }

  /** 软删除:归档(保留审计)。 */
  async archive(id: string): Promise<void> {
    await this.prisma.knowledgeEntry.update({
      where: { id },
      data: { status: "ARCHIVED" },
    });
  }

  /** 手动合并:把合并后的内容写入主条目并发布,其余归档。 */
  async applyManualMerge(
    primaryId: string,
    otherIds: string[],
    merged: { question: string; answer: string },
  ): Promise<KnowledgeEntryRecord> {
    const embedding = await this.computeEmbedding(merged.question);
    const ops = [
      this.prisma.knowledgeEntry.update({
        where: { id: primaryId },
        data: {
          question: merged.question,
          answer: merged.answer,
          status: "PUBLISHED",
          ...(embedding ? { embedding } : {}),
        },
      }),
      ...otherIds.map((oid) =>
        this.prisma.knowledgeEntry.update({
          where: { id: oid },
          data: { status: "ARCHIVED" },
        }),
      ),
    ];
    const [primary] = await this.prisma.$transaction(ops);
    return toRecord(primary);
  }
}

function toRecord(row: {
  id: string;
  question: string;
  answer: string;
  category: string | null;
  status: string;
  mergeTargetId: string | null;
  sourceTicketId: string | null;
  usageCount: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}): KnowledgeEntryRecord {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    category: row.category,
    status: row.status,
    mergeTargetId: row.mergeTargetId,
    sourceTicketId: row.sourceTicketId,
    usageCount: row.usageCount,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── 关键词工具(v1 粗筛用) ──────────────────────────────────────────────────

/**
 * 把文本切成检索词:ASCII 单词(≥2 字符) + 中文相邻二字组(bigram)。
 * 中文无词边界,bigram 比单字更能区分,够用于粗筛。
 */
export function tokenize(text: string): string[] {
  const lower = (text ?? "").toLowerCase();
  const terms = new Set<string>();

  for (const w of lower.match(/[a-z0-9]+/g) ?? []) {
    if (w.length >= 2) terms.add(w);
  }
  for (const run of lower.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) {
      terms.add(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) terms.add(run.slice(i, i + 2));
    }
  }
  return [...terms];
}

function scoreQuestion(queryTerms: string[], question: string): number {
  const qset = new Set(tokenize(question));
  let hits = 0;
  for (const t of queryTerms) if (qset.has(t)) hits++;
  return hits;
}
