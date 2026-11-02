import { render, screen } from "@testing-library/react";
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

  it("uses business tier names and preserves the configured allowance", async () => {
    render(<PlanCatalogPage />);
    expect(screen.queryByText("Codex 中转")).not.toBeInTheDocument();

    expect(await screen.findByRole('button', { name: '高配版' })).toBeInTheDocument();
    expect(screen.queryByText('母号额度池参考')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /max-20x/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Anthropic (Claude) 高配版 每份 5 小时美元额度')).toHaveValue(30);

  });
});
