import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { describe, it, expect } from "vitest";
import { codexFingerprintLease, codexFingerprintProbeHeaders } from "../codex-fingerprint";
import { CodexProvider } from "../codex.provider";
import { RosettaService } from "../../rosetta/rosetta.service";

describe("Codex fingerprint identity lifecycle", () => {
  it("defaults off, rejects invalid seeds, and does not expose its storage seed", () => {
    expect(codexFingerprintLease({})).toBeUndefined();
    expect(codexFingerprintLease({ codexFingerprintMode: "session", codexFingerprintSeed: "1" })).toBeUndefined();
    const account = { id: 1, email: "a", refreshToken: "rt", codexFingerprintMode: "session", codexFingerprintSeed: randomUUID() };
    const extras = new CodexProvider().leaseIdentityExtras(account);
    expect(extras.codexFingerprint).toEqual(codexFingerprintLease(account));
    expect(JSON.stringify(extras)).not.toContain(account.codexFingerprintSeed);
    expect(codexFingerprintProbeHeaders(account)).toEqual({ "x-codex-installation-id": codexFingerprintLease(account)!.installationId });
  });

  it("persists across restart, edits and disabling; isolates accounts and deployments with reused numeric IDs", () => {
    const dirs = [fs.mkdtempSync(path.join(os.tmpdir(), "gfa-fp-")), fs.mkdtempSync(path.join(os.tmpdir(), "gfa-fp-"))];
    try {
      const identities = dirs.map(dataDir => {
        const service = new RosettaService({ dataDir });
        service.addCodexAccount({ email: "test@example.test", refreshToken: "rt" });
        expect(service.setCodexFingerprint({ accountId: 1, mode: "bad" }).ok).toBe(false);
        expect(service.setCodexFingerprint({ accountId: 999, mode: "device" }).ok).toBe(false);
        expect(service.setCodexFingerprint({ accountId: 1, mode: "session", codexFingerprintSeed: randomUUID() }).ok).toBe(true);
        const read = () => JSON.parse(fs.readFileSync(path.join(dataDir, "codex-accounts.json"), "utf8")).accounts[0];
        const before = codexFingerprintLease(read());
        const restarted = new RosettaService({ dataDir });
        expect(restarted.listCodexAccounts().accounts[0].codexFingerprintMode).toBe("session");
        expect(JSON.stringify(restarted.listCodexAccounts())).not.toContain(read().codexFingerprintSeed);
        restarted.setCodexFingerprint({ accountId: 1, mode: "off" });
        expect(codexFingerprintLease(read())).toBeUndefined();
        restarted.setCodexFingerprint({ accountId: 1, mode: "session" });
        expect(codexFingerprintLease(read())).toEqual(before);
        restarted.importCodexAccountFromText({ text: JSON.stringify({ email: "test@example.test", refresh_token: "new-token" }) });
        expect(codexFingerprintLease(read())).toEqual(before);
        return before;
      });
      expect(identities[0]!.installationId).not.toBe(identities[1]!.installationId);
    } finally {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
