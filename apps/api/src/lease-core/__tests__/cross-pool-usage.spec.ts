import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LeaseService } from "../lease-service";
import type { Provider } from "../provider";
import { AccessKeyStore } from "../../token-server/access-key-store";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeProvider(id: string, accountsFilePath: string): Provider<any> {
  return {
    id,
    accountsFilePath,
    refreshToken: vi.fn(async () => "access-token"),
    normalizeAccount: (raw: any) => ({
      ...raw,
      id: Number(raw.id),
      email: String(raw.email || ""),
      refreshToken: String(raw.refreshToken || ""),
      enabled: raw.enabled !== false,
    }),
    isAccountEligible: () => true,
    applyQuotaSnapshot: (account: any) => ({ account, creditDelta: null }),
    egressPolicy: "optional" as const,
    leaseResponseExtras: () => ({}),
  } as unknown as Provider<any>;
}

const REQ = { headers: { "x-token-server-secret": "secret-card" } };

/**
 * One universal pool card is used across multiple product pools (codex +
 * anthropic). Each pool used to hold its OWN AccessKeyStore over the same
 * access-keys.json and blind-overwrite on flush, clobbering the other pool's
 * usage — so per-card limits were never reached. A single shared store makes the
 * card's usage accumulate across pools.
 */
describe("shared AccessKeyStore accumulates usage across product pools", () => {
  let tempDir: string;
  let codexAccounts: string;
  let anthropicAccounts: string;
  let accessKeysFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-cross-pool-"));
    codexAccounts = path.join(tempDir, "codex-accounts.json");
    anthropicAccounts = path.join(tempDir, "anthropic-accounts.json");
    accessKeysFilePath = path.join(tempDir, "access-keys.json");
    writeJson(codexAccounts, { accounts: [{ id: 1, email: "c@x.com", refreshToken: "rt-c", enabled: true }] });
    writeJson(anthropicAccounts, { accounts: [{ id: 2, email: "a@x.com", refreshToken: "rt-a", enabled: true }] });
    writeJson(accessKeysFilePath, {
      keys: [{ id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000 }],
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("a card used on codex then anthropic shows the SUM, not just the last pool", async () => {
    const sharedStore = new AccessKeyStore(accessKeysFilePath);
    const codex = new LeaseService(makeProvider("codex", codexAccounts), {
      accessKeyStore: sharedStore,
      minClientVersion: "",
    } as any);
    const anthropic = new LeaseService(makeProvider("anthropic", anthropicAccounts), {
      accessKeyStore: sharedStore,
      minClientVersion: "",
    } as any);

    const l1 = await codex.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });
    await codex.reportResult(REQ, {
      leaseId: l1.leaseId, status: 200, modelKey: "gpt-5-codex",
      inputTokens: 100, outputTokens: 50, totalTokens: 150,
    });

    const l2 = await anthropic.leaseToken(REQ, { clientId: "c1", modelKey: "claude-sonnet-4-6" });
    const r2 = await anthropic.reportResult(REQ, {
      leaseId: l2.leaseId, status: 200, modelKey: "claude-sonnet-4-6",
      inputTokens: 100, outputTokens: 50, totalTokens: 150,
    });

    // Shared store → 150 (codex) + 150 (anthropic) = 300. Separate stores → 150.
    expect(r2.accessKeyStatus.totalTokensUsed).toBe(300);
  });
});
