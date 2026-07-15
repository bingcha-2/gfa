import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const catalogHook = vi.hoisted(() => ({ value: null as any }));

vi.mock("@/app/(console)/console/(dashboard)/(product)/plan-catalog/use-plan-catalog", () => ({
  usePlanCatalog: () => catalogHook.value,
}));

vi.mock("@/app/(console)/console/(dashboard)/(product)/plan-catalog/use-account-levels", () => ({
  useAccountLevels: () => ({ levels: {}, loading: false }),
}));

import PlanCatalogPage from "@/app/(console)/console/(dashboard)/(product)/plan-catalog/page";
import { DEFAULT_CONFIG } from "@/app/(console)/console/(dashboard)/(product)/plan-catalog/catalog-defaults";

describe("PlanCatalogPage quota reference", () => {
  beforeEach(() => {
    catalogHook.value = {
      publishedConfig: DEFAULT_CONFIG,
      publishedVersion: 1,
      loading: false,
      error: "",
      refresh: vi.fn(),
      saveDraft: vi.fn(),
      publish: vi.fn(),
    };
  });

  it("updates the suggested per-share pool when the operator edits oversell factor", async () => {
    render(<PlanCatalogPage />);

    expect(await screen.findByText(/8 个基础份额 × 1\.5 倍超卖，共 12 份换算/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("超卖倍率"), { target: { value: "2" } });

    await waitFor(() => {
      expect(screen.getByText(/8 个基础份额 × 2 倍超卖，共 16 份换算/)).toBeInTheDocument();
    });
    const codex20xRow = screen.getByText("Codex Pro 20x").closest("tr");
    expect(codex20xRow).toHaveTextContent("$218.75");
  });
});
