import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/console/client-api", () => ({ apiRequest: mocks.api, getErrorMessage: (e: Error) => e.message }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, warning: mocks.warning, error: mocks.error } }));
vi.mock("@/lib/account/catalog-pricing", () => ({
  catalogLevelsFor: () => ["pro"],
  computePurchase: () => ({ priceCents: 100 }),
}));
import { GrantSubscriptionDialog } from "@/app/(console)/console/(dashboard)/(customer)/customers/[id]/grant-subscription-dialog";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ config: { products: ["anthropic"], durationDays: 30 } }) }));
});
afterEach(() => vi.unstubAllGlobals());

it.each(["ready", "attention"])("shows the allocation result and closes the completed grant: %s", async (status) => {
  const message = status === "ready" ? "订阅已发放，已自动分配 Claude 母号" : "订阅已发放，但没有可用母号。请到网关用户补分配，无需重复发放订阅";
  mocks.api.mockResolvedValue({ id: "sub", gatewayAllocation: { status, message } });
  const onOpenChange = vi.fn();
  const onGranted = vi.fn();
  render(<GrantSubscriptionDialog open onOpenChange={onOpenChange} customerId="customer" onGranted={onGranted} />);
  fireEvent.click(await screen.findByRole("button", { name: "Anthropic (Claude)" }));
  fireEvent.click(screen.getByRole("button", { name: "确认发放" }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(onGranted).toHaveBeenCalledTimes(1);
  expect(mocks.api).toHaveBeenCalledTimes(1);
  expect(mocks.api).toHaveBeenCalledWith("customers/customer/subscriptions", {
    method: "POST", body: { selection: { line: "bind", items: [{ product: "anthropic", level: "pro" }], shareSeats: 1, deviceLimit: 1 }, durationDays: 30 },
  });
  if (status === "attention") {
    expect(mocks.warning).toHaveBeenCalledWith(message, { duration: 12000 });
    expect(mocks.success).not.toHaveBeenCalled();
  } else expect(mocks.success).toHaveBeenCalledWith(message);
  expect(mocks.error).not.toHaveBeenCalled();
});
