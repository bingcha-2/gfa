import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";

import { ConsoleJwtGuard } from "../../../shared/auth/console-jwt.guard";
import { Roles } from "../../../shared/auth/roles.decorator";
import { SupportInsightsService } from "./support-insights.service";

/**
 * 后台客服分析(/api/console/support/*)。
 *   GET .../stats              — 运营看板指标
 *   GET .../conversations      — bot 会话列表(?status=)
 *   GET .../conversations/:id  — 单段会话全文(含工具痕迹)
 */
@Controller("console/support")
@UseGuards(ConsoleJwtGuard)
@Roles("ADMIN", "OPERATIONS")
export class SupportInsightsController {
  constructor(private readonly svc: SupportInsightsService) {}

  @Get("stats")
  stats() {
    return this.svc.stats();
  }

  @Get("conversations")
  list(@Query("status") status?: string) {
    return this.svc.listConversations(status);
  }

  @Get("conversations/:id")
  detail(@Param("id") id: string) {
    return this.svc.getConversation(id);
  }
}
