"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

import { userApi, logoutUser } from "@/lib/user-api";
import type { Customer } from "@/lib/user-types";

type PortalContextValue = {
  customer: Customer;
  refresh: () => Promise<void>;
  handleLogout: () => Promise<void>;
};

const PortalContext = createContext<PortalContextValue | null>(null);

export function usePortal(): PortalContextValue {
  const ctx = useContext(PortalContext);
  if (!ctx) throw new Error("usePortal must be used within PortalProvider");
  return ctx;
}

export function PortalProvider({
  initialCustomer,
  children,
}: {
  initialCustomer: Customer;
  children: ReactNode;
}) {
  const router = useRouter();
  const [customer, setCustomer] = useState<Customer>(initialCustomer);

  const refresh = useCallback(async () => {
    try {
      const updated = await userApi<Customer>("me");
      setCustomer(updated);
    } catch {
      // If token expired, redirect to login
      router.push("/app/login");
    }
  }, [router]);

  const handleLogout = useCallback(async () => {
    try {
      await logoutUser();
    } catch {
      // ignore logout errors
    }
    router.push("/app/login");
    router.refresh();
  }, [router]);

  return (
    <PortalContext.Provider value={{ customer, refresh, handleLogout }}>
      {children}
    </PortalContext.Provider>
  );
}
