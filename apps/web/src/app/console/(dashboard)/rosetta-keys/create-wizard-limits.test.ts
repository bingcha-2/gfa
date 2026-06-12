import { describe, expect, it } from "vitest";

import { buildCreateWizardBucketLimits } from "./create-wizard-limits";

describe("buildCreateWizardBucketLimits", () => {
  it("defaults blank pool-card model limits to 1 for every available bucket", () => {
    expect(
      buildCreateWizardBucketLimits({
        cardType: "pool",
        bucketLimits: {
          "antigravity-gemini": 50_000,
          "codex-gpt": 0,
        },
      }),
    ).toEqual({
      "antigravity-gemini": 50_000,
      "antigravity-claude": 1,
      "codex-gpt": 1,
      "anthropic-claude": 1,
    });
  });

  it("keeps bound-card blank model limits omitted", () => {
    expect(
      buildCreateWizardBucketLimits({
        cardType: "bound",
        bucketLimits: {
          "antigravity-gemini": 50_000,
          "codex-gpt": 0,
        },
      }),
    ).toEqual({
      "antigravity-gemini": 50_000,
    });
  });
});
