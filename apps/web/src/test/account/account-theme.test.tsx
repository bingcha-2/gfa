/**
 * Tests for account-only light/dark theme switching:
 *   src/components/account/account-theme.tsx
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { AccountThemeToggle, accountThemeInitScript } from "@/components/account/account-theme";

describe("account theme", () => {
  it("initializes account theme without using the marketing theme key", () => {
    expect(accountThemeInitScript).toContain("account-theme");
    expect(accountThemeInitScript).toContain("dataset.accountTheme");
    expect(accountThemeInitScript).not.toContain("mkt-theme");
  });

  it("toggles only the account theme dataset and storage key", () => {
    const setItem = vi.fn();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        setItem,
      },
    });
    document.documentElement.dataset.accountTheme = "light";

    render(<AccountThemeToggle />);
    fireEvent.click(screen.getByRole("button", { name: "切换账户界面深浅模式" }));

    expect(document.documentElement.dataset.accountTheme).toBe("dark");
    expect(setItem).toHaveBeenCalledWith("account-theme", "dark");
  });
});
