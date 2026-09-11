import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAccountBenefitsPanel } from "@/components/console/leasing/codex-account-benefits";
import { apiRequest } from "@/lib/console/client-api";
vi.mock("@/lib/console/client-api", () => ({ apiRequest: vi.fn(), getErrorMessage: String }));
const good = { ok: true, subscriptionExpiresAt: "2100-01-01T00:00:00Z", subscriptionCheckedAt: 1000,
  subscriptionError: "", resetCredits: { availableCount: 3, nextExpiresAt: null, error: "" } };

describe("mother account benefits display", () => {
  beforeEach(() => vi.resetAllMocks());
  it("loads expiry and credits, and refreshes only on request", async () => {
    vi.mocked(apiRequest).mockResolvedValue(good);
    const changed = vi.fn();
    const { rerender } = render(<CodexAccountBenefitsPanel accountId={38} refreshVersion={0} onUpdated={changed} />);
    expect(await screen.findByText("3 次")).toBeInTheDocument();
    expect(screen.getByText(/2100/)).toBeInTheDocument();
    expect(apiRequest).toHaveBeenCalledWith("rosetta/codex-account-benefits", { method: "POST", body: { accountId: 38, force: false } });
    rerender(<CodexAccountBenefitsPanel accountId={38} refreshVersion={0} onUpdated={() => {}} />);
    expect(apiRequest).toHaveBeenCalledTimes(1);
    vi.mocked(apiRequest).mockResolvedValue({ ...good, resetCredits: { ...good.resetCredits, availableCount: 0 } });
    rerender(<CodexAccountBenefitsPanel accountId={38} refreshVersion={1} />);
    expect(await screen.findByText("0 次")).toBeInTheDocument();
    expect(apiRequest).toHaveBeenLastCalledWith("rosetta/codex-account-benefits", { method: "POST", body: { accountId: 38, force: true } });
  });
  it("shows unknown expiry and failed credits without a false zero", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ ...good, subscriptionExpiresAt: null,
      resetCredits: { availableCount: null, error: "重置卡查询失败" } });
    render(<CodexAccountBenefitsPanel accountId={38} refreshVersion={0} />);
    expect(await screen.findByText("上游未提供")).toBeInTheDocument();
    expect(screen.getByText("查询失败")).toBeInTheDocument();
    expect(screen.queryByText("0 次")).not.toBeInTheDocument();
  });
  it("labels stale expiry when subscription refresh fails", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ ...good, subscriptionExpiresAt: "2020-01-01T00:00:00Z", subscriptionError: "订阅查询失败" });
    render(<CodexAccountBenefitsPanel accountId={38} refreshVersion={0} />);
    expect(await screen.findByText("刷新失败，显示上次结果")).toBeInTheDocument();
    expect(screen.getByText("已到期")).toBeInTheDocument();
    expect(screen.getByText("3 次")).toBeInTheDocument();
  });
  it("ignores a late response from the previous account", async () => {
    let finish!: (data: any) => void;
    vi.mocked(apiRequest).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ ...good, resetCredits: { ...good.resetCredits, availableCount: 8 } });
    const { rerender } = render(<CodexAccountBenefitsPanel accountId={38} refreshVersion={0} />);
    rerender(<CodexAccountBenefitsPanel accountId={39} refreshVersion={0} />);
    await screen.findByText("8 次");
    await act(async () => finish(good));
    await waitFor(() => expect(screen.queryByText("3 次")).not.toBeInTheDocument());
  });

  it("reopening a previously refreshed panel uses cache and does not refresh the list", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ ...good, updated: false });
    const changed = vi.fn();
    render(<CodexAccountBenefitsPanel accountId={38} refreshVersion={4} onUpdated={changed} />);
    await screen.findByText("3 次");
    expect(apiRequest).toHaveBeenCalledWith("rosetta/codex-account-benefits", { method: "POST", body: { accountId: 38, force: false } });
    expect(changed).not.toHaveBeenCalled();
  });
});
