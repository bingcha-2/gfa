import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CustomerDetailPage from "@/app/(console)/console/(dashboard)/(customer)/customers/[id]/page";
import { apiRequest } from "@/lib/console/client-api";
import { toast } from "sonner";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "cust-1" }) }));
vi.mock("@/lib/console/client-api", () => ({ apiRequest: vi.fn(), getErrorMessage: String }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/(console)/console/(dashboard)/(customer)/customers/[id]/grant-subscription-dialog", () => ({ GrantSubscriptionDialog: () => null }));
vi.mock("@/app/(console)/console/(dashboard)/(customer)/subscriptions/subscription-detail-drawer", () => ({ SubscriptionDetailDrawer: () => null }));

describe("customer subscription device editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiRequest).mockResolvedValue({
      id: "cust-1", email: "customer@example.com", status: "ACTIVE", creditCents: 0,
      createdAt: "2026-01-01T00:00:00Z", planOrders: [], devices: [],
      subscriptions: [{
        id: "sub-1", status: "ACTIVE", expiresAt: null, startsAt: "2026-01-01T00:00:00Z",
        deviceLimit: 1, weight: 1,
        config: JSON.stringify({ line: "bind", products: ["codex"], bindings: { codex: 11 }, deviceLimit: 1 }),
      }],
    });
  });

  it("prefills device count and saves a lifetime subscription without changing expiry", async () => {
    render(<CustomerDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: /^编辑$/ }));
    const input = await screen.findByLabelText("可用设备数");
    expect(input).toHaveValue(1);
    expect(screen.getByText(/多条有效订阅取设备数最大值/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("subscriptions/sub-1", {
      method: "PATCH", body: { deviceLimit: 3 },
    }));
    expect(toast.success).toHaveBeenCalledWith("订阅已更新");
  });

  it.each(["0", "1.5", ""])("rejects invalid device count %s", async (value) => {
    render(<CustomerDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: /^编辑$/ }));
    fireEvent.change(await screen.findByLabelText("可用设备数"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
    expect(toast.error).toHaveBeenCalledWith("可用设备数必须是大于等于 1 的有效整数");
    expect(vi.mocked(apiRequest).mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(false);
  });
});
