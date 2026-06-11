import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { BullModule } from "@nestjs/bullmq";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerModule } from "@nestjs/throttler";
import { RealIpThrottlerGuard } from "./common/real-ip-throttler.guard";

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
import { AutomationModule } from "./automation/automation.module";
import { SchedulerModule } from "./scheduler/scheduler.module";
import { PhonePoolModule } from "./phone-pool/phone-pool.module";
import { FaqModule } from "./faq/faq.module";
import { HealthController } from "./health.controller";


import { StatsController } from "./stats.controller";
import { TokenServerModule } from "./token-server/token-server.module";
import { RosettaModule } from "./rosetta/rosetta.module";
import { RemoteCodexModule } from "./remote-codex/remote-codex.module";
import { RemoteAnthropicModule } from "./remote-anthropic/remote-anthropic.module";
import { RemoteStatsModule } from "./remote-stats/remote-stats.module";
import { Bulk2faModule } from "./bulk-2fa/bulk-2fa.module";
import { MailModule } from "./mail/mail.module";
import { WebModule } from "./web/web.module";
import { AppSurfaceModule } from "./app/app-surface.module";
import { PlanModule } from "./plan/plan.module";
import { SubscriptionModule } from "./subscription/subscription.module";

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
        ttl: 60000,
        limit: 10000 // basically disabled for local dev
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
    ExpireScanModule,
    AutomationModule,
    SchedulerModule,
    PhonePoolModule,
    FaqModule,
    TokenServerModule,
    RemoteCodexModule,
    RemoteAnthropicModule,
    RemoteStatsModule,
    RosettaModule,
    Bulk2faModule,
    MailModule,
    WebModule,
    AppSurfaceModule,
    PlanModule,
    SubscriptionModule,
  ],
  controllers: [HealthController, StatsController],
  providers: [
    // RealIpThrottlerGuard must be first so rate-limit is checked before auth
    { provide: APP_GUARD, useClass: RealIpThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard }
  ]
})
export class AppModule {}
