import { Module } from "@nestjs/common";

import { SubscriptionService } from "./subscription.service";
import { EntitlementSyncService } from "./entitlement-sync.service";
import { TokenServerModule } from "../token-server/token-server.module";
import { RemoteCodexModule } from "../remote-codex/remote-codex.module";
import { RemoteAnthropicModule } from "../remote-anthropic/remote-anthropic.module";
import { RosettaModule } from "../rosetta/rosetta.module";

/**
 * SubscriptionModule — subscription lifecycle + entitlement sync into the
 * shared access-key store (shadow records).
 *
 * Imports the three pool modules so the sync can reload every pool after a
 * write (mirrors rosetta's reloadKeyStores), and RosettaModule for the single
 * access-keys.json writer. PrismaModule is @Global.
 */
@Module({
  imports: [TokenServerModule, RemoteCodexModule, RemoteAnthropicModule, RosettaModule],
  providers: [SubscriptionService, EntitlementSyncService],
  exports: [SubscriptionService, EntitlementSyncService],
})
export class SubscriptionModule {}
