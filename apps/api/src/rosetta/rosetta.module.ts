import { Module } from "@nestjs/common";

import { RosettaController } from "./rosetta.controller";
import { RosettaService } from "./rosetta.service";
import { TokenServerModule } from "../token-server/token-server.module";

@Module({
  imports: [TokenServerModule],
  controllers: [RosettaController],
  providers: [RosettaService],
  exports: [RosettaService],
})
export class RosettaModule {}
