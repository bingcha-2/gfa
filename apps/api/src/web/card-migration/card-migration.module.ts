import { Module } from "@nestjs/common";

import { CardMigrationController } from "./card-migration.controller";
import { CardMigrationService } from "./card-migration.service";
import { CustomerAuthModule } from "../customer-auth/customer-auth.module";
import { TokenServerModule } from "../../token-server/token-server.module";
import { RemoteCodexModule } from "../../remote-codex/remote-codex.module";
import { RemoteAnthropicModule } from "../../remote-anthropic/remote-anthropic.module";
import { RosettaModule } from "../../rosetta/rosetta.module";

/**
 * CardMigrationModule — bind-card migration of legacy card keys onto customer
 * subscriptions. Imports the three pool modules (post-write reloads), the
 * RosettaModule (single access-keys.json writer), and CustomerAuthModule
 * (CustomerJwtGuard). PrismaModule is @Global.
 */
@Module({
  imports: [CustomerAuthModule, TokenServerModule, RemoteCodexModule, RemoteAnthropicModule, RosettaModule],
  controllers: [CardMigrationController],
  providers: [CardMigrationService],
  exports: [CardMigrationService],
})
export class CardMigrationModule {}
