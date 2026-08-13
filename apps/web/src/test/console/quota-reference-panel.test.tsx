import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { QuotaReferencePanel } from "@/app/(console)/console/(dashboard)/(product)/plan-catalog/quota-reference-panel";

describe("QuotaReferencePanel", () => {
  it("展示全部母号档位、整号池和默认单份额度", () => {
    render(<QuotaReferencePanel />);

    expect(screen.getByText("资料快照 2026-08-13")).toBeInTheDocument();
    for (const plan of ["Codex Pro 5x", "Codex Pro 20x", "Claude Pro", "Claude Max 5x", "Claude Max 20x"]) {
      expect(screen.getByText(plan)).toBeInTheDocument();
    }

    const codex20xRow = screen.getByText("Codex Pro 20x").closest("tr");
    expect(codex20xRow).not.toBeNull();
    expect(within(codex20xRow!).getAllByText("$0")).toHaveLength(2);
    expect(within(codex20xRow!).getByText("$800")).toBeInTheDocument();
    expect(within(codex20xRow!).getByText("$100")).toBeInTheDocument();
    expect(within(codex20xRow!).getByText("每份固定额度")).toBeInTheDocument();
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

  it("Codex 单份额度不随超卖倍率变化，Claude 仍按服务端向上取整口径换算", () => {
    const { rerender } = render(<QuotaReferencePanel oversellFactor="2" />);

    expect(screen.getByText(/8 个基础份额 × 2 倍超卖，共 16 份换算/)).toBeInTheDocument();
    let codex20xRow = screen.getByText("Codex Pro 20x").closest("tr");
    expect(codex20xRow).not.toBeNull();
    expect(within(codex20xRow!).getByText("$100")).toBeInTheDocument();
    let claudeProRow = screen.getByText("Claude Pro").closest("tr");
    expect(claudeProRow).not.toBeNull();
    expect(within(claudeProRow!).getByText("$11.875")).toBeInTheDocument();

    rerender(<QuotaReferencePanel oversellFactor="1.51" />);
    expect(screen.getByText(/8 个基础份额 × 1\.51 倍超卖，共 13 份换算/)).toBeInTheDocument();
    codex20xRow = screen.getByText("Codex Pro 20x").closest("tr");
    expect(within(codex20xRow!).getByText("$100")).toBeInTheDocument();
    claudeProRow = screen.getByText("Claude Pro").closest("tr");
    expect(within(claudeProRow!).getByText("$14.615385")).toBeInTheDocument();

    rerender(<QuotaReferencePanel oversellFactor="" />);
    expect(screen.getByText(/8 个基础份额 × 1\.5 倍超卖，共 12 份换算/)).toBeInTheDocument();
  });
});
