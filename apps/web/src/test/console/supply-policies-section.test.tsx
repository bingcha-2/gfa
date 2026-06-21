import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SupplyPoliciesSection } from "@/app/(console)/console/(dashboard)/(product)/plan-catalog/usage-section";

describe("SupplyPoliciesSection", () => {
  it("edits antigravity full quotas as fixed bucket sources", () => {
    const onChange = vi.fn();

    render(
      <SupplyPoliciesSection
        products={[{ product: "antigravity", enabled: true, levels: ["ultra"] }]}
        value={{
          antigravity: {
            defaultLevel: "ultra",
            salesSeatsPerAccount: { ultra: "8" },
            buckets: {
              "antigravity-gemini": {
                source: "learned",
                provider: "antigravity",
                planType: "ultra",
                family: "gemini",
              },
              "antigravity-claude": {
                source: "learned",
                provider: "antigravity",
                planType: "ultra",
                family: "claude",
              },
            },
          },
        }}
        onChange={onChange}
      />,
    );

    const gemini5h = screen.getByLabelText(
      "Antigravity (Gemini) · Gemini 5h 满额",
    ) as HTMLInputElement;
    expect(gemini5h.value).toBe("100000000");

    fireEvent.change(gemini5h, { target: { value: "110000000" } });

    expect(onChange).toHaveBeenLastCalledWith({
      antigravity: expect.objectContaining({
        buckets: expect.objectContaining({
          "antigravity-gemini": {
            source: "fixed",
            window5h: "110000000",
            weekly: "400000000",
          },
        }),
      }),
    });
  });
});
