// Shared account-pool helper used by multiple account domain services.
// Extracted verbatim from RosettaService.setAccountEnabled.

import * as path from "path";

import { nowIso, readJson, writeJson } from "./store";

/** Toggle an account's `enabled` flag in a provider pool file (accounts.json / codex-accounts.json / anthropic-accounts.json). */
export function setAccountEnabled(dataDir: string, fileName: string, accountId: number, enabled: boolean): void {
  const filePath = path.join(dataDir, fileName);
  const data = readJson(filePath, { accounts: [] });
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  const acc = accounts.find((a: any) => Number(a.id) === accountId);
  if (!acc) return;
  acc.enabled = enabled;
  writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
}
