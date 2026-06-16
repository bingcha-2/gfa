import { Injectable, Logger, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import { LlmClient } from "../../account/support-agent/llm/llm.client";
import {
  KnowledgeEntryRecord,
  KnowledgeService,
} from "../../support-knowledge/knowledge.service";
import {
  buildDistillMessages,
  buildMergeMessages,
  parseDistilled,
} from "./distill.prompt";

/** 单个工单的提炼结果。 */
export interface DistillOutcome {
  ticketId: string;
  outcome:
    | "draft" // 新建草稿
    | "merge_suggested" // 同类已存在 → 生成合并建议
    | "skipped" // 模型判定无可沉淀价值
    | "parse_failed" // 模型输出无法解析
    | "not_found"; // 工单不存在
  entryId?: string;
  question?: string;
}

/** 一次最多同步提炼的工单数(手动勾选,批量很小)。 */
const MAX_BATCH = 20;

/**
 * SupportKnowledgeAdminService —— 后台知识管理 + 工单提炼(知识飞轮的写侧)。
 *
 * 提炼为「同步」执行(不走 BullMQ):本仓库的 BullMQ 接的是独立浏览器 worker 进程,
 * 而提炼只是一次 LLM 调用 + 落库;工作人员手动勾选的批量很小(上限 20),同步处理
 * 更自洽、易验证,也不依赖 worker 是否在跑。
 */
@Injectable()
export class SupportKnowledgeAdminService {
  private readonly logger = new Logger(SupportKnowledgeAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmClient,
    private readonly knowledge: KnowledgeService,
  ) {}

  // ── 提炼 ────────────────────────────────────────────────────────────────────

  async distillTickets(ticketIds: string[]): Promise<{
    processed: number;
    results: DistillOutcome[];
  }> {
    if (!this.llm.enabled) {
      throw new NotFoundException({
        error: "SUPPORT_AGENT_DISABLED",
        message: "AI 客服未启用,无法提炼。",
      });
    }
    const ids = [...new Set(ticketIds)].slice(0, MAX_BATCH);
    const results: DistillOutcome[] = [];
    for (const id of ids) {
      results.push(await this.distillOne(id));
    }
    return { processed: results.length, results };
  }

  private async distillOne(ticketId: string): Promise<DistillOutcome> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: {
        subject: true,
        messages: {
          orderBy: { createdAt: "asc" },
          select: { authorType: true, body: true },
        },
      },
    });
    if (!ticket) return { ticketId, outcome: "not_found" };

    let raw: string;
    try {
      raw = await this.llm.complete(buildDistillMessages(ticket));
    } catch (err) {
      this.logger.warn(`distill LLM failed for ${ticketId}: ${errMsg(err)}`);
      return { ticketId, outcome: "parse_failed" };
    }

    const distilled = parseDistilled(raw);
    if (!distilled) return { ticketId, outcome: "parse_failed" };
    if (!distilled.worthSaving) return { ticketId, outcome: "skipped" };

    // 去重:有同类 → 合并建议;否则新草稿。
    const similar = await this.knowledge.findSimilar(distilled.question);
    if (similar) {
      let mergedAnswer = distilled.answer;
      try {
        const merged = await this.llm.complete(
          buildMergeMessages(distilled.question, [
            similar.answer,
            distilled.answer,
          ]),
        );
        if (merged.trim()) mergedAnswer = merged.trim();
      } catch (err) {
        this.logger.warn(`merge LLM failed for ${ticketId}: ${errMsg(err)}`);
      }
      const entry = await this.knowledge.createMergeSuggestion({
        question: distilled.question,
        answer: mergedAnswer,
        category: distilled.category,
        sourceTicketId: ticketId,
        mergeTargetId: similar.id,
      });
      return {
        ticketId,
        outcome: "merge_suggested",
        entryId: entry.id,
        question: distilled.question,
      };
    }

    const entry = await this.knowledge.createDraft({
      question: distilled.question,
      answer: distilled.answer,
      category: distilled.category,
      sourceTicketId: ticketId,
    });
    return {
      ticketId,
      outcome: "draft",
      entryId: entry.id,
      question: distilled.question,
    };
  }

  // ── 后台 CRUD ───────────────────────────────────────────────────────────────

  list(status?: string): Promise<KnowledgeEntryRecord[]> {
    return this.knowledge.list(status);
  }

  /** 手动录入一条知识(默认直接发布)。 */
  create(input: {
    question: string;
    answer: string;
    category?: string | null;
    publish?: boolean;
  }): Promise<KnowledgeEntryRecord> {
    return this.knowledge.createManual(
      { question: input.question, answer: input.answer, category: input.category },
      input.publish !== false,
    );
  }

  update(
    id: string,
    patch: { question?: string; answer?: string; category?: string | null },
  ): Promise<KnowledgeEntryRecord> {
    return this.knowledge.update(id, patch);
  }

  async publish(id: string): Promise<KnowledgeEntryRecord> {
    const out = await this.knowledge.publish(id);
    if (!out) {
      throw new NotFoundException({ error: "KNOWLEDGE_NOT_FOUND" });
    }
    return out;
  }

  archive(id: string): Promise<void> {
    return this.knowledge.archive(id);
  }

  /** 手动合并:LLM 揉合主条目与其余条目的答案,写回主条目并发布,其余归档。 */
  async merge(
    primaryId: string,
    otherIds: string[],
  ): Promise<KnowledgeEntryRecord> {
    const ids = [primaryId, ...otherIds.filter((x) => x !== primaryId)];
    const entries = await Promise.all(
      ids.map((id) => this.knowledge.getById(id)),
    );
    const primary = entries[0];
    if (!primary) throw new NotFoundException({ error: "KNOWLEDGE_NOT_FOUND" });

    const answers = entries.filter((e): e is KnowledgeEntryRecord => !!e).map((e) => e.answer);

    let mergedAnswer = primary.answer;
    if (this.llm.enabled && answers.length > 1) {
      try {
        const merged = await this.llm.complete(
          buildMergeMessages(primary.question, answers),
        );
        if (merged.trim()) mergedAnswer = merged.trim();
      } catch (err) {
        this.logger.warn(`manual merge LLM failed: ${errMsg(err)}`);
      }
    }

    return this.knowledge.applyManualMerge(
      primaryId,
      otherIds.filter((x) => x !== primaryId),
      { question: primary.question, answer: mergedAnswer },
    );
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
