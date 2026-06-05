import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { AccessKeyStore } from "../access-key-store";
import { CODEX_BILLING } from "../../remote-codex/codex.provider";

let tmpDir: string;
let accessKeysPath: string;
let nowVal: number;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "access-key-codex-"));
  accessKeysPath = path.join(tmpDir, "access-keys.json");
  nowVal = Date.parse("2026-05-29T00:00:00.000Z");
  vi.spyOn(Date, "now").mockImplementation(() => nowVal);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;

describe("AccessKeyStore — codex billing bucket", () => {
  function codexStore(tokenWindowLimit: number) {
    fs.writeFileSync(accessKeysPath, JSON.stringify({
      keys: [{ id: "c", key: "cs", status: "active", provider: "codex", durationMs: 365 * DAY, tokenWindowLimit }],
      updatedAt: "",
    }));
    return new AccessKeyStore(accessKeysPath, CODEX_BILLING);
  }

  it("bills codex usage under the composite codex-gpt bucket, not claude", () => {
    const store = codexStore(1000);
    store.recordUsage("c", 200, { totalTokens: 300 }, "gpt-5-codex", "r1", "codex");

    const st = store.publicStatus(store.findById("c")!) as any;
    expect(st.opusTokensUsed).toBe(0);
    expect(st.geminiTokensUsed).toBe(0);
    const codexBucket = st.buckets.find((b: any) => b.bucket === "codex-gpt");
    expect(codexBucket.used).toBe(300);
    expect(codexBucket.limit).toBe(1000);
  });

  it("rejects over the codex 5h bucket limit with a Codex-labelled error", () => {
    const store = codexStore(200);
    store.recordUsage("c", 200, { totalTokens: 200 }, "gpt-5-codex", "r1", "codex");

    const res = store.resolveFromRequest(
      { headers: { "x-access-key": "cs" } } as any,
      {},
      { enforceLimit: true, modelKey: "gpt-5-codex", product: "codex" },
    );
    expect(res.record).toBeNull();
    expect(res.error).toContain("Codex");
    expect(res.error).toContain("token limit exceeded");
  });
});
