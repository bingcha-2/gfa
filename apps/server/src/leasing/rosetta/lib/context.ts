// Shared dependency bundle every rosetta domain service receives from the
// RosettaService facade. Keeps each extracted service decoupled from the facade
// while sharing the same dataDir, caches, token cache, OAuth fetch impls, etc.

import { Logger } from "@nestjs/common";

import type { AgentAccountService } from "../../../google-family/automation/agent-account.service";
import type { AutomationService } from "../../../google-family/automation/automation.service";
import type { CachedToken } from "../google-api";
import type { CachedJsonFile } from "./store";
import type { AccessKeyStore } from "../../token-server/access-key-store";

export type RosettaContext = {
  dataDir: string;
  logger: Logger;
  /** In-memory access_token cache: accountId → { accessToken, expiresAt }. */
  tokenCache: Map<number, CachedToken>;
  /** mtime-cached readers for hot-path list queries. */
  accessKeysFile: CachedJsonFile;
  accountsFile: CachedJsonFile;
  codexOAuthFetch: typeof fetch;
  claudeOAuthFetch: typeof fetch;
  codexOAuthPort: number;
  automation?: AutomationService;
  agentAccounts?: AgentAccountService;
  /** Authoritative in-memory per-card window usage. When present, the admin
   *  list reads usage from here instead of the (event-free) access-keys.json. */
  accessKeyStore?: AccessKeyStore;
};
