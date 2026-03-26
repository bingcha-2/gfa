import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { BullModule } from "@nestjs/bullmq";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";

import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { RolesGuard } from "./auth/roles.guard";
import { AuditLogModule } from "./audit-log/audit-log.module";
import { AccountModule } from "./account/account.module";
import { FamilyGroupModule } from "./family-group/family-group.module";
import { RedeemCodeModule } from "./redeem-code/redeem-code.module";
import { OrderModule } from "./order/order.module";
import { TaskModule } from "./task/task.module";
import { ExpireScanModule } from "./expire-scan/expire-scan.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env.local", ".env", "../../.env.local", "../../.env"]
    }),
    // S-03: Global rate limiting — 60 req per 60 seconds by default
    ThrottlerModule.forRoot([
      {
        name: "default",
        ttl: 60000, // 60 seconds window
        limit: 60   // 60 requests per window
      }
    ]),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        skipWaitingForReady: true,
        extraOptions: {
          manualRegistration: true
        },
        connection: {
          url: configService.get<string>("REDIS_URL", "redis://localhost:6379"),
          maxRetriesPerRequest: null
        }
      })
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    AuditLogModule,
    AccountModule,
    FamilyGroupModule,
    RedeemCodeModule,
    OrderModule,
    TaskModule,
    ExpireScanModule
  ],
  controllers: [HealthController],
  providers: [
    // ThrottlerGuard must be first so rate-limit is checked before auth
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard }
  ]
})
export class AppModule {}
