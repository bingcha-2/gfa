import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccessKeyService } from "../access-key.service";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * A per-card limit must be keyed by a composite <product>-<family> bucket. A
 * bare-family key ("claude") sets hasBucketCaps but the enforce lookup (which
 * uses the composite key) never matches it, so the limit silently never trips.
 * updateAccessKey drops such invalid keys so a misconfig can't masquerade as a
 * working limit.
 */
describe("updateAccessKey rejects invalid bucketLimits keys", () => {
  let dataDir: string;
  let filePath: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-bucket-validate-"));
    filePath = path.join(dataDir, "access-keys.json");
    writeJson(filePath, { keys: [{ id: "card-1", key: "secret", status: "active" }] });
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps valid composite buckets and drops bare-family ones", () => {
    const svc = new AccessKeyService({ dataDir } as any);
    try {
      svc.updateAccessKey({
        id: "card-1",
        bucketLimits: { claude: 1_000_000, "antigravity-claude": 2_000_000 },
      });
    } catch {
      // The persisted write (what enforcement reads) happens before the method
      // formats its return value via listAccessKeys, which needs a fuller ctx.
    }

    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const rec = data.keys.find((k: any) => k.id === "card-1");

    expect(rec.bucketLimits["antigravity-claude"]).toBe(2_000_000); // valid kept
    expect(rec.bucketLimits.claude).toBeUndefined(); // bare family dropped
  });
});
