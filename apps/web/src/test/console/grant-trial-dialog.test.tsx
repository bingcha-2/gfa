import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GrantTrialDialog } from "@/app/(console)/console/(dashboard)/(customer)/customers/[id]/grant-trial-dialog";

const { toast } = vi.hoisted(() => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast }));

describe("GrantTrialDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    toast.success.mockReset();
    toast.info.mockReset();
    toast.error.mockReset();
  });

  it("posts the selected duration and Codex weekly USD limit", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      created: true,
      subscription: { id: "trial-sub-1", expiresAt: "2026-07-27T00:00:00.000Z" },
    }), { status: 200 }));
    const onOpenChange = vi.fn();
    const onGranted = vi.fn();

    render(
      <GrantTrialDialog
        open
        onOpenChange={onOpenChange}
        customerId="cust-1"
        customerEmail="trial@example.com"
        onGranted={onGranted}
      />,
    );

    fireEvent.change(screen.getByLabelText("试用天数"), { target: { value: "7" } });
    expect(screen.getByLabelText("每周额度（USD）")).toHaveValue(20);
    fireEvent.change(screen.getByLabelText("每周额度（USD）"), {
      target: { value: "6" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认发放" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/console/customers/cust-1/trial");
    expect(options?.method).toBe("POST");
    expect(JSON.parse(String(options?.body))).toEqual({
      durationDays: 7,
      weeklyUsdLimit: 6,
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      "已开通 7 天 Codex 试用，每周额度 $6.00",
    ));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onGranted).toHaveBeenCalled();
  });

  it("blocks invalid durations before sending a request", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    render(
      <GrantTrialDialog
        open
        onOpenChange={vi.fn()}
        customerId="cust-1"
        customerEmail="trial@example.com"
        onGranted={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("试用天数"), { target: { value: "0" } });

    expect(screen.getByText("请输入 1-365 的整数。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认发放" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks invalid weekly USD limits before sending a request", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    render(
      <GrantTrialDialog
        open
        onOpenChange={vi.fn()}
        customerId="cust-1"
        customerEmail="trial@example.com"
        onGranted={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("每周额度（USD）"), {
      target: { value: "0" },
    });

    expect(screen.getByText("请输入大于 $0 且不超过 $1,000,000 的金额。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认发放" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

});
