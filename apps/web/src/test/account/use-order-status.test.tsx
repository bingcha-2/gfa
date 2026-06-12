/**
 * Tests for the order status polling hook:
 *   src/lib/account/use-order-status.ts
 *
 * Fake timers throughout — asserts polling cadence, terminal-status stop,
 * unmount cleanup, and visibility pausing with zero leaked timers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useOrderStatus } from "@/lib/account/use-order-status";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useOrderStatus", () => {
  it("does not poll when outTradeNo is null", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    renderHook(() => useOrderStatus(null));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("polls immediately and then every 3 seconds while PENDING", async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ outTradeNo: "T1", status: "PENDING" }))
      );
    vi.stubGlobal("fetch", mockFetch);

    renderHook(() => useOrderStatus("T1"));

    // Immediate first poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toContain(
      "/api/account/billing/orders/T1"
    );

    // Every 3s thereafter
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("exposes the latest order state and stops polling on PAID", async () => {
    const mockFetch = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(jsonResponse({ outTradeNo: "T1", status: "PENDING" }))
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          jsonResponse({
            outTradeNo: "T1",
            status: "PAID",
            paidAt: "2026-06-11T00:00:00.000Z",
          })
        )
      );
    vi.stubGlobal("fetch", mockFetch);

    const { result } = renderHook(() => useOrderStatus("T1"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current?.status).toBe("PENDING");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current?.status).toBe("PAID");

    // Terminal — no more polls no matter how long we wait
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("stops polling on unmount (zero leaked timers)", async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ outTradeNo: "T1", status: "PENDING" }))
      );
    vi.stubGlobal("fetch", mockFetch);

    const { unmount } = renderHook(() => useOrderStatus("T1"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops polling when outTradeNo becomes null (dialog closed)", async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ outTradeNo: "T1", status: "PENDING" }))
      );
    vi.stubGlobal("fetch", mockFetch);

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useOrderStatus(id),
      { initialProps: { id: "T1" as string | null } }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    rerender({ id: null });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.current).toBeNull();
  });

  it("skips fetches while the document is hidden and resumes when visible", async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ outTradeNo: "T1", status: "PENDING" }))
      );
    vi.stubGlobal("fetch", mockFetch);

    renderHook(() => useOrderStatus("T1"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Tab goes to background — polling pauses (no network calls)
    visibility = "hidden";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Tab visible again — polling resumes on the next interval
    visibility = "visible";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
