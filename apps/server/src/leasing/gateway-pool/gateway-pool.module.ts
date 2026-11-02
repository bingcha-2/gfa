import { Module } from "@nestjs/common";

import { CustomerAuthModule } from "../account/customer-auth/customer-auth.module";
import { GatewayForwardController } from "./gateway-forward.controller";
import { GatewayPoolController } from "./gateway-pool.controller";
import { GatewayPoolService } from "./gateway-pool.service";
import { GatewayClientController, GatewayUserAdminController } from "./gateway-user.controller";
import { GatewayUserService } from "./gateway-user.service";

/**
 * GatewayPoolModule — 第三方母号池 + 网关用户 + 服务端转发。
 *   - 母号:后台增删、5 分钟同步用量/模型、上游窗口重置检测
 *   - 用户:按份额分配,专用 key,按官方价计费,额度用尽即拒绝
 *   - 转发:/api/gateway/v1/*,母号 key 只在服务端解密,不下发
 * PrismaModule / AuditLogModule 均 @Global。
 */
@Module({
  imports: [CustomerAuthModule],
  controllers: [GatewayPoolController, GatewayUserAdminController, GatewayClientController, GatewayForwardController],
  providers: [GatewayPoolService, GatewayUserService],
  exports: [GatewayPoolService, GatewayUserService],
})
export class GatewayPoolModule {}
