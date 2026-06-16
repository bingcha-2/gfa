import {
  Body,
  Controller,
  Get,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";

import { Public } from "../../../shared/auth/public.decorator";
import { CustomerJwtGuard } from "../customer-auth/customer-jwt.guard";
import { CurrentCustomer } from "../customer-auth/customer.decorator";
import { CustomerUser } from "../customer-auth/customer-jwt.strategy";
import { ConversationService } from "./conversation.service";
import { SupportAgentService } from "./support-agent.service";
import { SupportChatDto } from "./dto/support.dto";

/**
 * SupportController — 客户端 AI 客服(/api/account/support/*)。
 *
 *   GET  /api/account/support/conversation  载最近一段对话 + 是否启用
 *   POST /api/account/support/chat          发消息,SSE 流式返回
 *
 * 全程 CustomerJwtGuard;customerId 取自 JWT,数据按客户隔离。
 */
@Controller("account/support")
@Public()
@UseGuards(CustomerJwtGuard)
export class SupportController {
  constructor(
    private readonly agent: SupportAgentService,
    private readonly conversations: ConversationService,
  ) {}

  @Get("conversation")
  async conversation(@CurrentCustomer() customer: CustomerUser) {
    const conversation = await this.conversations.getLatestForCustomer(
      customer.customerId,
    );
    return { enabled: this.agent.enabled, conversation };
  }

  /**
   * POST /api/account/support/chat
   * Body: { conversationId?, message }
   * → SSE 流:每帧 `data: {SseEvent}\n\n`(meta/delta/tool/done/error)
   */
  @Post("chat")
  async chat(
    @CurrentCustomer() customer: CustomerUser,
    @Body() dto: SupportChatDto,
    @Res() res: any,
  ) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // 关掉 nginx 缓冲,实时透传
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    const write = (data: unknown) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (typeof res.flush === "function") res.flush();
    };

    try {
      for await (const ev of this.agent.run(
        { customerId: customer.customerId },
        dto.conversationId,
        dto.message,
      )) {
        write(ev);
      }
    } catch {
      // 兜底:run() 内部已尽量收敛异常;万一漏网,给客户端一个 error 帧。
      write({ type: "error", message: "服务异常,请稍后再试。" });
    } finally {
      res.end();
    }
  }
}
