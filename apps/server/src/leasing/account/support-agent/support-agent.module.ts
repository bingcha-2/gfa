import { Module } from "@nestjs/common";

import { BillingModule } from "../billing/billing.module";
import { CustomerAuthModule } from "../customer-auth/customer-auth.module";
import { TicketModule } from "../ticket/ticket.module";
import { SupportKnowledgeModule } from "../../support-knowledge/support-knowledge.module";
import { ConversationService } from "./conversation.service";
import { ConversationSweeperService } from "./conversation-sweeper.service";
import { SupportLlmModule } from "./llm/llm.module";
import { SupportAgentService } from "./support-agent.service";
import { SupportController } from "./support.controller";

/**
 * SupportAgentModule — 客户端 AI 客服(全自动对话 + 知识检索 + 升级工单)。
 *
 * 依赖:
 *   - CustomerAuthModule — CustomerJwtGuard + CustomerAuthService(查资料)
 *   - BillingModule      — BillingService(查订阅/订单)
 *   - TicketModule       — TicketService(升级建工单)
 *   - SupportKnowledgeModule — KnowledgeService(知识检索)
 *
 * NOTE: app.module.ts 必须 import 本模块以激活路由。
 */
@Module({
  imports: [
    SupportLlmModule,
    CustomerAuthModule,
    BillingModule,
    TicketModule,
    SupportKnowledgeModule,
  ],
  controllers: [SupportController],
  providers: [ConversationService, ConversationSweeperService, SupportAgentService],
})
export class SupportAgentModule {}
