import { Module } from "@nestjs/common";

import { AccountLevelsController } from "./account-levels.controller";
import { AccountLevelsService } from "./account-levels.service";

/**
 * AccountLevelsModule — console「账号池实际等级」只读查询(GET console/account-levels)。
 * 供套餐配置页绑定线等级从下拉里选。PrismaModule / AuditLogModule 均 @Global。
 * 服务的 dataDir 走构造函数默认(defaultRemoteAccessDataDir),与其它读账号池的服务一致。
 */
@Module({
  controllers: [AccountLevelsController],
  providers: [AccountLevelsService],
})
export class AccountLevelsModule {}
