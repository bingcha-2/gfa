import { Module } from "@nestjs/common";

import { SupportLlmModule } from "../account/support-agent/llm/llm.module";
import { KnowledgeService } from "./knowledge.service";

/**
 * SupportKnowledgeModule — 客服知识库读侧(知识飞轮)。
 * 检索(关键词 + P3 语义)、提炼写侧由 KnowledgeService 提供。
 *
 * 导入 SupportLlmModule 以注入 EmbeddingClient(语义检索);PrismaModule 为 @Global。
 */
@Module({
  imports: [SupportLlmModule],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class SupportKnowledgeModule {}
