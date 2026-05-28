import { Module } from "@nestjs/common";

import { TokenServerController } from "./token-server.controller";
import { TokenServerService } from "./token-server.service";
import { CreditTracker } from "./credit-tracker";
import { PrismaService } from "../prisma/prisma.service";

const creditTrackerProvider = {
  provide: "CREDIT_TRACKER",
  useFactory: (prisma: PrismaService) => new CreditTracker(prisma),
  inject: [PrismaService],
};

const tokenServerProvider = {
  provide: TokenServerService,
  useFactory: (creditTracker: CreditTracker) =>
    new TokenServerService({ creditTracker }),
  inject: ["CREDIT_TRACKER"],
};

@Module({
  controllers: [TokenServerController],
  providers: [creditTrackerProvider, tokenServerProvider],
  exports: [TokenServerService],
})
export class TokenServerModule {}
