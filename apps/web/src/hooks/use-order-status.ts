"use client";

import { useEffect, useState } from "react";

import { getBillingOrderState } from "@/lib/user-api";
import type { BillingOrderState } from "@/lib/user-types";

const TERMINAL_STATUSES = new Set(["PAID", "FAILED", "EXPIRED", "REFUNDED"]);

/**
 * Poll a billing order's status while it is pending.
 *
 * - Polls immediately, then every `intervalMs` (default 3s).
 * - Skips network calls while document.visibilityState !== "visible"
 *   (timer keeps ticking cheaply; fetches resume when the tab is visible).
 * - Stops permanently on a terminal status (PAID/FAILED/EXPIRED/REFUNDED).
 * - Cleans up fully on unmount or when outTradeNo becomes null — no leaked timers.
 *
 * @param outTradeNo pass null when no order is active (dialog closed).
 */
export function useOrderStatus(
  outTradeNo: string | null,
  intervalMs = 3000
): BillingOrderState | null {
  const [order, setOrder] = useState<BillingOrderState | null>(null);

  useEffect(() => {
    // Reset stale state from a previous order on every identity change.
    setOrder(null);

    if (!outTradeNo) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function schedule() {
      if (cancelled) return;
      timer = setTimeout(tick, intervalMs);
    }

    async function tick() {
      if (cancelled) return;

      // Pause polling while the tab is hidden — no wasted requests.
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        schedule();
        return;
      }

      try {
        const next = await getBillingOrderState(outTradeNo!);
        if (cancelled) return;
        setOrder(next);
        if (TERMINAL_STATUSES.has(next.status)) {
          return; // terminal — stop polling for good
        }
      } catch {
        // Transient error (network blip) — keep polling.
      }
      schedule();
    }

    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [outTradeNo, intervalMs]);

  return order;
}
