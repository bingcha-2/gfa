import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { ConversationService } from "./conversation.service";

/**
 * ConversationSweeperService —— 定时把空闲超 30 分钟、仍 OPEN 的客服会话置 CLOSED。
 *
 * 会话生命周期与"是否转人工"是两个维度:status 只表示 OPEN/CLOSED,转人工看 ticketId。
 * 不依赖用户"回来发消息"才懒关闭,定时清扫让看板的"进行中/已结束"及时准确。
 */
@Injectable()
export class ConversationSweeperService {
  private readonly logger = new Logger(ConversationSweeperService.name);

  constructor(private readonly conversations: ConversationService) {}

  @Cron(CronExpression.EVERY_2_HOURS)
  async sweep(): Promise<void> {
    try {
      const closed = await this.conversations.closeIdleConversations();
      if (closed > 0) {
        this.logger.log(`closed ${closed} idle support conversation(s)`);
      }
    } catch (err) {
      this.logger.warn(
        `idle-conversation sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
