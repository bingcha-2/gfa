import { describe, expect, it } from "vitest";

import { extractOpenAIVerificationCode } from "../mailcom-web-magic-link";

describe("extractOpenAIVerificationCode", () => {
  it("extracts the six-digit OpenAI code from an HTML email", () => {
    expect(extractOpenAIVerificationCode(`
      <html><body>
        <p>Your temporary ChatGPT verification code is:</p>
        <strong>482 731</strong>
      </body></html>
    `)).toBe("482731");
  });

  it("does not guess when an email contains multiple unrelated codes", () => {
    expect(extractOpenAIVerificationCode("Order 123456, reference 654321")).toBe("");
  });
});
