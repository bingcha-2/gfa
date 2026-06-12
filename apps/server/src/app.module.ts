import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { BullModule } from "@nestjs/bullmq";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerModule } from "@nestjs/throttler";
import { RealIpThrottlerGuard } from "./shared/common/real-ip-throttler.guard";

import { PrismaModule } from "./shared/prisma/prisma.module";
import { AuthModule } from "./shared/auth/auth.module";
import { JwtAuthGuard } from "./shared/auth/jwt-auth.guard";
import { RolesGuard } from "./shared/auth/roles.guard";
import { AuditLogModule } from "./shared/audit-log/audit-log.module";
import { AccountModule } from "./google-family/account/account.module";
import { FamilyGroupModule } from "./google-family/family-group/family-group.module";
import { RedeemCodeModule } from "./google-family/redeem-code/redeem-code.module";
import { OrderModule } from "./google-family/order/order.module";
import { TaskModule } from "./google-family/task/task.module";
import { ExpireScanModule } from "./google-family/expire-scan/expire-scan.module";
import { AutomationModule } from "./google-family/automation/automation.module";
import { SchedulerModule } from "./google-family/scheduler/scheduler.module";
import { PhonePoolModule } from "./google-family/phone-pool/phone-pool.module";
import { FaqModule } from "./shared/faq/faq.module";
import { HealthController } from "./shared/health.controller";


import { StatsController } from "./google-family/stats.controller";
import { TokenServerModule } from "./leasing/token-server/token-server.module";
import { RosettaModule } from "./leasing/rosetta/rosetta.module";
import { RemoteCodexModule } from "./leasing/remote-codex/remote-codex.module";
import { RemoteAnthropicModule } from "./leasing/remote-anthropic/remote-anthropic.module";
import { RemoteStatsModule } from "./leasing/remote-stats/remote-stats.module";
import { Bulk2faModule } from "./google-family/bulk-2fa/bulk-2fa.module";
import { MailModule } from "./shared/mail/mail.module";
// Aliased: google-family already exports an AccountModule (Google account admin).
import { AccountModule as AccountSurfaceModule } from "./leasing/account/account.module";
import { AppSurfaceModule } from "./leasing/app/app-surface.module";
import { PlanModule } from "./leasing/plan/plan.module";
import { PlanCatalogModule } from "./leasing/plan-catalog/plan-catalog.module";
import { SubscriptionModule } from "./leasing/subscription/subscription.module";
import { BillingAdminModule } from "./leasing/console/billing-admin/billing-admin.module";
import { CustomerAdminModule } from "./leasing/console/customer-admin/customer-admin.module";
import { TicketAdminModule } from "./leasing/console/ticket-admin/ticket-admin.module";
import { ReferralAdminModule } from "./leasing/console/referral-admin/referral-admin.module";
import { CardMigrationModule } from "./leasing/account/card-migration/card-migration.module";
import { BillingModule } from "./leasing/account/billing/billing.module";
import { PortalModule } from "./leasing/account/portal/portal.module";
import { NotificationModule } from "./leasing/account/notification/notification.module";
import { TicketModule } from "./leasing/account/ticket/ticket.module";
import { ReferralModule } from "./leasing/account/referral/referral.module";

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
    AccountSurfaceModule,
    AppSurfaceModule,
    PlanModule,
    PlanCatalogModule,
    SubscriptionModule,
    BillingAdminModule,
    CustomerAdminModule,
    TicketAdminModule,
    ReferralAdminModule,
    CardMigrationModule,
    BillingModule,
    PortalModule,
    NotificationModule,
    TicketModule,
    ReferralModule,
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
