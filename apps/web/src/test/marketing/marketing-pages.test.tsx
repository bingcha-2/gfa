import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("marketing page redesign source contracts", () => {
  it("homepage uses real product imagery and avoids the old hero trust strip", () => {
    const source = read("app/(marketing)/page.tsx");

    expect(source).toContain("/product-shots/client-preview-beautified.png");
    expect(source).not.toContain("mkt-hero__trust");
    expect(source).not.toContain("<ClientMock");
  });

  it("marketing pages use the new mixed-layout primitives", () => {
    const files = [
      "app/(marketing)/features/page.tsx",
      "app/(marketing)/how-it-works/page.tsx",
      "app/(marketing)/quickstart/page.tsx",
      "app/(marketing)/download/page.tsx",
      "app/(marketing)/faq/page.tsx",
    ];

    const combined = files.map(read).join("\n");
    expect(combined).toContain("mkt-feature-band");
    expect(combined).toContain("mkt-process");
    expect(combined).toContain("mkt-download-matrix");
    expect(combined).toContain("mkt-support-panel");
  });
});
