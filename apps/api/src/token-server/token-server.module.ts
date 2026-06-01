import { Module } from "@nestjs/common";

import { TokenServerController } from "./token-server.controller";
import { TokenServerService } from "./token-server.service";
import { CreditTracker } from "./credit-tracker";
import { TokenUsageTracker } from "./token-usage-tracker";
import { PrismaService } from "../prisma/prisma.service";

const creditTrackerProvider = {
  provide: "CREDIT_TRACKER",
  useFactory: (prisma: PrismaService) => new CreditTracker(prisma),
  inject: [PrismaService],
};

const tokenUsageTrackerProvider = {
  provide: "TOKEN_USAGE_TRACKER",
  useFactory: (prisma: PrismaService) => new TokenUsageTracker(prisma),
  inject: [PrismaService],
};

const tokenServerProvider = {
  provide: TokenServerService,
  useFactory: (creditTracker: CreditTracker, tokenUsageTracker: TokenUsageTracker) =>
    new TokenServerService({ creditTracker, tokenUsageTracker }),
  inject: ["CREDIT_TRACKER", "TOKEN_USAGE_TRACKER"],
};

@Module({
  controllers: [TokenServerController],
  providers: [creditTrackerProvider, tokenUsageTrackerProvider, tokenServerProvider],
  exports: [TokenServerService, "TOKEN_USAGE_TRACKER"],
})
export class TokenServerModule {}
