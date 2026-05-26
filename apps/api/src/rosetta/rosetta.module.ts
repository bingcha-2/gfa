import { Module } from "@nestjs/common";

import { RosettaController } from "./rosetta.controller";
import { RosettaService } from "./rosetta.service";

@Module({
  controllers: [RosettaController],
  providers: [RosettaService],
  exports: [RosettaService],
})
export class RosettaModule {}
