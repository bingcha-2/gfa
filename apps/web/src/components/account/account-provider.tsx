"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useRouter } from "next/navigation";

import { getNotifications, userApi, logoutUser } from "@/lib/account/user-api";
import type { Customer } from "@/lib/account/user-types";

type AccountContextValue = {
  customer: Customer;
  refresh: () => Promise<void>;
  handleLogout: () => Promise<void>;
  /**
   * Unread notification count behind the topnav bell badge. Lives here (not in
   * the topnav) so the notification center can clear it optimistically without
   * a full reload — the provider outlives client-side route changes.
   */
  unread: number;
  setUnread: Dispatch<SetStateAction<number>>;
  refreshUnread: () => Promise<void>;
};

const AccountContext = createContext<AccountContextValue | null>(null);

export function useAccount(): AccountContextValue {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error("useAccount must be used within AccountProvider");
  return ctx;
}

export function AccountProvider({
  initialCustomer,
  children,
}: {
  initialCustomer: Customer;
  children: ReactNode;
}) {
  const router = useRouter();
  const [customer, setCustomer] = useState<Customer>(initialCustomer);
  const [unread, setUnread] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const { customer: updated } = await userApi<{ customer: Customer }>("me");
      setCustomer(updated);
    } catch {
      // If token expired, redirect to login
      router.push("/account/login");
    }
  }, [router]);

  const refreshUnread = useCallback(async () => {
    try {
      const page = await getNotifications(1, 1);
      setUnread(page.unread);
    } catch {
      // Keep the last known count on a transient failure — no badge flicker.
    }
  }, []);

  // One-shot on mount (no polling). Replaces the topnav's old local fetch.
  useEffect(() => {
    void refreshUnread();
  }, [refreshUnread]);

  const handleLogout = useCallback(async () => {
    try {
      await logoutUser();
    } catch {
      // ignore logout errors
    }
    router.push("/account/login");
    router.refresh();
  }, [router]);

  return (
    <AccountContext.Provider
      value={{ customer, refresh, handleLogout, unread, setUnread, refreshUnread }}
    >
      {children}
    </AccountContext.Provider>
  );
}
