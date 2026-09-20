import { createHash } from "crypto";
import * as fs from "fs";
import { readCodexAccountRestriction } from "../../lease-core/codex-health";
import { nowIso, writeJson } from "../../rosetta/lib/store";

/** Local coordination/storage failure must never count as upstream token death. */
export class CodexLocalCredentialError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexLocalCredentialError";
  }
}

/** Never log this stamp's input: it includes the credential generation. */
export function codexCredentialStamp(account: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify([
    Number(account.id), String(account.email || "").toLowerCase(),
    account.codexCredentialVersion || "", account.refreshToken || "",
    account.accessToken || "", account.accessTokenExpiresAt || 0, account.sessionToken || "",
  ])).digest("hex");
}

export function assertCodexAccountMaintenanceAllowed(account: Record<string, unknown>): void {
  const restriction = readCodexAccountRestriction(account);
  if (restriction) throw new CodexLocalCredentialError(`Codex account requires administrator review: ${restriction}`);
}

export function readCodexStoredAccount(filePath: string, accountId: number) {
  // A read/parse error must not turn into an empty pool that is subsequently saved.
  let data: any;
  try { data = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { throw new CodexLocalCredentialError("Codex credential storage is unreadable", { cause: error }); }
  const accounts: any[] = Array.isArray(data) ? data : data?.accounts;
  if (!Array.isArray(accounts)) throw new CodexLocalCredentialError("Codex account store is invalid");
  const account = accounts.find((item) => Number(item?.id) === Number(accountId));
  if (!account) throw new CodexLocalCredentialError("Codex account was removed");
  return { data, account };
}

/** Synchronous read/compare/patch/write: no old account array survives an await. */
export function updateCodexStoredAccount(
  filePath: string,
  expected: Record<string, unknown>,
  update: (account: any) => void,
  options: { allowRestricted?: boolean } = {},
) {
  const { data, account } = readCodexStoredAccount(filePath, Number(expected.id));
  if (codexCredentialStamp(account) !== codexCredentialStamp(expected)) {
    throw new CodexLocalCredentialError("Codex credentials changed during the request; retry with the current account");
  }
  if (!options.allowRestricted) assertCodexAccountMaintenanceAllowed(account);
  update(account);
  try { writeJson(filePath, Array.isArray(data) ? data : { ...data, updatedAt: nowIso() }); }
  catch (error) { throw new CodexLocalCredentialError("Codex credential storage write failed; retry to save the pending rotation", { cause: error }); }
  return account;
}
