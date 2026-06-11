"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

import { userApi, logoutUser } from "@/lib/account/user-api";
import type { Customer } from "@/lib/account/user-types";

type AccountContextValue = {
  customer: Customer;
  refresh: () => Promise<void>;
  handleLogout: () => Promise<void>;
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

  const refresh = useCallback(async () => {
    try {
      const updated = await userApi<Customer>("me");
      setCustomer(updated);
    } catch {
      // If token expired, redirect to login
      router.push("/account/login");
    }
  }, [router]);

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
    <AccountContext.Provider value={{ customer, refresh, handleLogout }}>
      {children}
    </AccountContext.Provider>
  );
}
