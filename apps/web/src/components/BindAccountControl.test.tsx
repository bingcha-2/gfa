import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BindAccountControl, type BindableAccount } from "./BindAccountControl";

const ACCOUNTS: BindableAccount[] = [
  { provider: "codex", id: 7, email: "codex-a@x.com", usedShares: 2, shareCapacity: 4 },
  { provider: "codex", id: 8, email: "codex-full@x.com", usedShares: 4, shareCapacity: 4 },
  { provider: "antigravity", id: 1, email: "anti-a@x.com", usedShares: 0, shareCapacity: 4 },
];

describe("BindAccountControl", () => {
  it("pool card: shows 池子模式 and a 设置 button", () => {
    render(<BindAccountControl card={{ id: "c1" }} accounts={ACCOUNTS} onApply={vi.fn()} />);
    expect(screen.getByText(/池子模式/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
  });

  it("bound card: shows the binding summary and a 设置 button", () => {
    render(
      <BindAccountControl
        card={{ id: "c1", bindings: { codex: 7 } }}
        accounts={ACCOUNTS}
        onApply={vi.fn()}
      />,
    );
    expect(screen.getByText(/Codex · codex-a@x\.com/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
  });

  it("falls back to #id when a bound account was deleted", () => {
    render(
      <BindAccountControl
        card={{ id: "c1", bindings: { codex: 99 } }}
        accounts={ACCOUNTS}
        onApply={vi.fn()}
      />,
    );
    expect(screen.getByText(/#99/)).toBeInTheDocument();
  });

  it("opens a dialog with a mode selector (like the create form)", () => {
    render(<BindAccountControl card={{ id: "c1" }} accounts={ACCOUNTS} onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByText("设置绑定账号")).toBeInTheDocument();
    expect(screen.getByText("模式")).toBeInTheDocument();
  });

  it("saving an unchanged bound card submits its current bindings", () => {
    const onApply = vi.fn();
    render(
      <BindAccountControl
        card={{ id: "c1", bindings: { codex: 7 } }}
        accounts={ACCOUNTS}
        onApply={onApply}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onApply).toHaveBeenCalledWith({ codex: 7 });
  });

  it("saving a pool card submits an empty map (stays pool)", () => {
    const onApply = vi.fn();
    render(<BindAccountControl card={{ id: "c1" }} accounts={ACCOUNTS} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onApply).toHaveBeenCalledWith({});
  });
});
