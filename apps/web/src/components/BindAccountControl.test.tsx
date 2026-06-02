import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BindAccountControl, type BindableAccount } from "./BindAccountControl";

const ACCOUNTS: BindableAccount[] = [
  { provider: "codex", id: 7, email: "codex-a@x.com", usedShares: 2, shareCapacity: 4 },
  { provider: "codex", id: 8, email: "codex-full@x.com", usedShares: 4, shareCapacity: 4 },
  { provider: "antigravity", id: 1, email: "anti-a@x.com", usedShares: 0, shareCapacity: 4 },
];

describe("BindAccountControl", () => {
  it("shows a pool-mode label and NO bind picker for a card with no bindings", () => {
    // 池子卡是"不绑号"的,后台不该出现绑定框 —— 池子/绑定在建卡时由产品决定。
    render(
      <BindAccountControl card={{ id: "c1" }} accounts={ACCOUNTS} onBind={vi.fn()} onUnbind={vi.fn()} />,
    );
    expect(screen.getByText(/池子模式/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "绑定" })).toBeNull();
    expect(screen.queryByPlaceholderText(/筛选/)).toBeNull();
  });

  it("binds the chosen account+provider for the still-unbound pool", () => {
    const onBind = vi.fn();
    // Bound to antigravity already → picker offers codex.
    render(
      <BindAccountControl
        card={{ id: "c1", bindings: { antigravity: 1 } }}
        accounts={ACCOUNTS}
        onBind={onBind}
        onUnbind={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "codex:7" } });
    fireEvent.click(screen.getByRole("button", { name: "绑定" }));
    expect(onBind).toHaveBeenCalledWith("codex", 7);
  });

  it("filters the account options by the typed query", () => {
    render(
      <BindAccountControl
        card={{ id: "c1", bindings: { antigravity: 1 } }}
        accounts={ACCOUNTS}
        onBind={vi.fn()}
        onUnbind={vi.fn()}
      />,
    );
    // Before filtering, both codex accounts are listed.
    expect(screen.getByRole("option", { name: /codex-a@x\.com/ })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/筛选/), { target: { value: "full" } });

    // Only the matching account remains in the dropdown.
    expect(screen.getByRole("option", { name: /codex-full@x\.com/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /codex-a@x\.com/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /anti-a@x\.com/ })).toBeNull();
  });

  it("disables an account with no room for a 1-share card (4/4 used)", () => {
    render(
      <BindAccountControl
        card={{ id: "c1", bindings: { antigravity: 1 } }}
        accounts={ACCOUNTS}
        onBind={vi.fn()}
        onUnbind={vi.fn()}
      />,
    );
    expect(screen.getByRole("option", { name: /codex-full@x\.com/ })).toBeDisabled();
    expect(screen.getByRole("option", { name: /codex-a@x\.com/ })).not.toBeDisabled();
  });

  it("disables an account that can't fit the card's weight (exclusive card needs 4 free)", () => {
    render(
      <BindAccountControl
        card={{ id: "c1", weight: 4, bindings: { antigravity: 1 } }}
        accounts={[{ provider: "codex", id: 9, email: "two-used@x.com", usedShares: 2, shareCapacity: 4 }]}
        onBind={vi.fn()}
        onUnbind={vi.fn()}
      />,
    );
    // 2 used + 4 needed > 4 → no room → disabled.
    expect(screen.getByRole("option", { name: /two-used@x\.com/ })).toBeDisabled();
  });

  it("shows each binding and unbinds the chosen provider", () => {
    const onUnbind = vi.fn();
    render(
      <BindAccountControl
        card={{ id: "c1", bindings: { codex: 7, antigravity: 1 } }}
        accounts={ACCOUNTS}
        onBind={vi.fn()}
        onUnbind={onUnbind}
      />,
    );
    expect(screen.getByRole("button", { name: "解绑 Codex" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "解绑 Antigravity" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "解绑 Codex" }));
    expect(onUnbind).toHaveBeenCalledWith("codex");
  });

  it("only offers accounts for products the card is not yet bound to", () => {
    render(
      <BindAccountControl
        card={{ id: "c1", bindings: { codex: 7 } }}
        accounts={ACCOUNTS}
        onBind={vi.fn()}
        onUnbind={vi.fn()}
      />,
    );
    // codex already bound → its accounts must NOT be offered…
    expect(screen.queryByRole("option", { name: /codex-a@x\.com/ })).toBeNull();
    // …only the still-unbound antigravity pool is offered.
    expect(screen.getByRole("option", { name: /anti-a@x\.com/ })).toBeInTheDocument();
  });

  it("hides the add-binding picker once both pools are bound", () => {
    render(
      <BindAccountControl
        card={{ id: "c1", bindings: { codex: 7, antigravity: 1 } }}
        accounts={ACCOUNTS}
        onBind={vi.fn()}
        onUnbind={vi.fn()}
      />,
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "绑定" })).toBeNull();
  });

  it("falls back to #id when a bound account was deleted", () => {
    render(
      <BindAccountControl
        card={{ id: "c1", bindings: { codex: 99 } }}
        accounts={ACCOUNTS}
        onBind={vi.fn()}
        onUnbind={vi.fn()}
      />,
    );
    expect(screen.getByText(/#99/)).toBeInTheDocument();
  });
});
