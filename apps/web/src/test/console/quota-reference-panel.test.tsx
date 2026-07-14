import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { QuotaReferencePanel } from "@/app/(console)/console/(dashboard)/(product)/plan-catalog/quota-reference-panel";

describe("QuotaReferencePanel", () => {
  it("展示全部母号档位、整号池和默认单份额度", () => {
    render(<QuotaReferencePanel />);

    expect(screen.getByText("资料快照 2026-07-14")).toBeInTheDocument();
    for (const plan of ["Codex Pro 5x", "Codex Pro 20x", "Claude Pro", "Claude Max 5x", "Claude Max 20x"]) {
      expect(screen.getByText(plan)).toBeInTheDocument();
    }

    const codex20xRow = screen.getByText("Codex Pro 20x").closest("tr");
    expect(codex20xRow).not.toBeNull();
    expect(within(codex20xRow!).getAllByText("$0")).toHaveLength(2);
    expect(within(codex20xRow!).getByText("$3,500")).toBeInTheDocument();
    expect(within(codex20xRow!).getByText("$291.666667")).toBeInTheDocument();
    expect(within(codex20xRow!).getByText("5h 已停用")).toBeInTheDocument();
  });

  it("提供可核验的官方和实测资料链接", () => {
    render(<QuotaReferencePanel />);

    expect(screen.getByRole("link", { name: /OpenAI 官方价格/ })).toHaveAttribute(
      "href",
      "https://learn.chatgpt.com/docs/pricing",
    );
    expect(screen.getByRole("link", { name: /Anthropic 官方说明/ })).toHaveAttribute(
      "href",
      "https://support.claude.com/en/articles/11049741-what-is-the-max-plan",
    );
    expect(screen.getAllByRole("link")).toHaveLength(4);
  });

  it("按表单超卖倍率实时重算建议单份额度，并与服务端向上取整口径一致", () => {
    const { rerender } = render(<QuotaReferencePanel oversellFactor="2" />);

    expect(screen.getByText(/8 个基础份额 × 2 倍超卖，共 16 份换算/)).toBeInTheDocument();
    let codex20xRow = screen.getByText("Codex Pro 20x").closest("tr");
    expect(codex20xRow).not.toBeNull();
    expect(within(codex20xRow!).getByText("$218.75")).toBeInTheDocument();

    rerender(<QuotaReferencePanel oversellFactor="1.51" />);
    expect(screen.getByText(/8 个基础份额 × 1\.51 倍超卖，共 13 份换算/)).toBeInTheDocument();
    codex20xRow = screen.getByText("Codex Pro 20x").closest("tr");
    expect(within(codex20xRow!).getByText("$269.230769")).toBeInTheDocument();

    rerender(<QuotaReferencePanel oversellFactor="" />);
    expect(screen.getByText(/8 个基础份额 × 1\.5 倍超卖，共 12 份换算/)).toBeInTheDocument();
  });
});
