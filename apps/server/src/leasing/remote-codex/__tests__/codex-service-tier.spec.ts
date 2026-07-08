import { describe, expect, it } from "vitest";

import { codexPlanSupportsFast } from "../codex-service-tier";

describe("codexPlanSupportsFast", () => {
  it.each([
    ["pro", true],
    ["Pro", true],
    ["  pro  ", true],
    ["chatgpt_pro", true],
    ["team", true],
    ["business", true],
    ["enterprise", true],
    ["edu", true],
    ["plus", false],
    ["Plus", false],
    ["free", false],
    ["", false],
    ["unknown", false],
  ] as const)("%s -> %s", (plan, want) => {
    expect(codexPlanSupportsFast(plan)).toBe(want);
  });
});

