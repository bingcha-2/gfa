import { Module } from "@nestjs/common";

import { SupportInsightsController } from "./support-insights.controller";
import { SupportInsightsService } from "./support-insights.service";

/**
 * SupportInsightsModule — 后台客服分析(会话回看 + 运营看板)。PrismaModule 为 @Global。
 * NOTE: app.module.ts 必须 import 本模块以激活路由。
 */
@Module({
  controllers: [SupportInsightsController],
  providers: [SupportInsightsService],
})
export class SupportInsightsModule {}
