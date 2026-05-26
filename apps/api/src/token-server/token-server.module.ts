import { Module } from "@nestjs/common";

import { TokenServerController } from "./token-server.controller";
import { TokenServerService } from "./token-server.service";

@Module({
  controllers: [TokenServerController],
  providers: [TokenServerService],
  exports: [TokenServerService],
})
export class TokenServerModule {}
