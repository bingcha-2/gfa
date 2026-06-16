import { Module } from "@nestjs/common";

import { SupportLlmModule } from "../../account/support-agent/llm/llm.module";
import { SupportKnowledgeModule } from "../../support-knowledge/support-knowledge.module";
import { SupportKnowledgeAdminController } from "./support-knowledge-admin.controller";
import { SupportKnowledgeAdminService } from "./support-knowledge-admin.service";

/**
 * SupportKnowledgeAdminModule — 后台知识管理 + 工单提炼(知识飞轮写侧)。
 * PrismaModule 为 @Global;LlmClient/KnowledgeService 经导入模块取得。
 *
 * NOTE: app.module.ts 必须 import 本模块以激活路由。
 */
@Module({
  imports: [SupportLlmModule, SupportKnowledgeModule],
  controllers: [SupportKnowledgeAdminController],
  providers: [SupportKnowledgeAdminService],
})
export class SupportKnowledgeAdminModule {}
