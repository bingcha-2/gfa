import { isDeepStrictEqual } from "node:util";
import { codexCredentialStamp } from "../remote-codex/auth/codex-account-store";

type Account = Record<string, unknown>;
type FieldValue = { present: boolean; value: unknown };
type FieldPatch = { before: FieldValue; after: FieldValue };
type AccountPatch = {
  identity: string;
  fields: Map<string, FieldPatch>;
  credentialBase?: Account;
};

const IDENTITY_FIELDS = new Set(["id", "email", "codexCredentialVersion"]);
const CREDENTIAL_FIELDS = new Set(["accessToken", "accessTokenExpiresAt", "refreshToken", "sessionToken", "idToken"]);
const UNSAFE_FIELDS = new Set(["__proto__", "prototype", "constructor"]);

function identity(account: Account): string {
  return JSON.stringify([
    Number(account.id), String(account.email || "").toLowerCase(), account.codexCredentialVersion ?? "",
  ]);
}

function field(account: Account, key: string): FieldValue {
  return { present: Object.prototype.hasOwnProperty.call(account, key), value: account[key] };
}

function writeField(account: Account, key: string, value: FieldValue): void {
  if (value.present) account[key] = structuredClone(value.value);
  else delete account[key];
}

function credentialBase(account: Account): Account {
  const base: Account = {};
  for (const key of [...IDENTITY_FIELDS, ...CREDENTIAL_FIELDS]) {
    if (Object.prototype.hasOwnProperty.call(account, key)) base[key] = structuredClone(account[key]);
  }
  return base;
}

function credentialMatches(left: Account, right: Account): boolean {
  // idToken is not currently persisted by Codex, but if a caller adds it then
  // its changes must have the same protection as the existing token fields.
  return codexCredentialStamp(left) === codexCredentialStamp(right)
    && isDeepStrictEqual(field(left, "idToken"), field(right, "idToken"));
}

/** Pending field changes only. Disk remains authoritative for identities and
 * fields another writer changed. Successful persistence, not a cache reload,
 * is the point at which the caller should clear this journal. */
export class CodexAccountPatches {
  private readonly pending = new Map<number, AccountPatch>();

  record(before: Account, after: Account): void {
    const id = Number(before.id);
    if (!Number.isSafeInteger(id) || id <= 0 || identity(before) !== identity(after)) return;
    const expectedIdentity = identity(before);
    let patch = this.pending.get(id);
    if (patch && patch.identity !== expectedIdentity) {
      this.pending.delete(id);
      patch = undefined;
    }
    const changedKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => !IDENTITY_FIELDS.has(key) && !UNSAFE_FIELDS.has(key)
        && !isDeepStrictEqual(field(before, key), field(after, key)));
    if (changedKeys.length === 0) return;
    if (!patch) {
      patch = { identity: expectedIdentity, fields: new Map() };
      this.pending.set(id, patch);
    }

    if (changedKeys.some((key) => CREDENTIAL_FIELDS.has(key))) {
      if (patch.credentialBase) {
        const projected = structuredClone(patch.credentialBase);
        for (const [key, change] of patch.fields) {
          if (CREDENTIAL_FIELDS.has(key)) writeField(projected, key, change.after);
        }
        // A new mutation based on externally rotated credentials supersedes
        // old credential patches; ordinary quota/hold changes remain pending.
        if (!credentialMatches(before, patch.credentialBase) && !credentialMatches(before, projected)) {
          for (const key of CREDENTIAL_FIELDS) patch.fields.delete(key);
          patch.credentialBase = undefined;
        }
      }
      patch.credentialBase ??= credentialBase(before);
    }

    for (const key of changedKeys) {
      const change = patch.fields.get(key);
      const current = field(before, key);
      // A reload may retain an external writer's conflicting value. A later
      // local update based on that new value is a fresh CAS, not a continuation
      // of the patch that lost the conflict.
      const rebased = change && !isDeepStrictEqual(current, change.before)
        && !isDeepStrictEqual(current, change.after);
      const original = change && !rebased ? change.before : structuredClone(current);
      const target = structuredClone(field(after, key));
      if (isDeepStrictEqual(original, target)) patch.fields.delete(key);
      else patch.fields.set(key, { before: original, after: target });
    }
    if (![...patch.fields.keys()].some((key) => CREDENTIAL_FIELDS.has(key))) patch.credentialBase = undefined;
    if (patch.fields.size === 0) this.pending.delete(id);
  }

  apply(diskAccounts: unknown[]): unknown[] {
    return diskAccounts.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return structuredClone(raw);
      const disk = raw as Account;
      const result = structuredClone(disk);
      const patch = this.pending.get(Number(disk.id));
      if (!patch || patch.identity !== identity(disk)) return result;
      const credentialsMatch = !!patch.credentialBase && credentialMatches(disk, patch.credentialBase);
      for (const [key, change] of patch.fields) {
        if (CREDENTIAL_FIELDS.has(key) && !credentialsMatch) continue;
        if (isDeepStrictEqual(field(disk, key), change.before)) writeField(result, key, change.after);
      }
      return result;
    });
  }

  clear(): void {
    this.pending.clear();
  }
}
