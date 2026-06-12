"use client";

import "./account.css";

import type { ReactNode } from "react";
import { Toaster } from "sonner";

import { AccountProvider } from "./account-provider";
import { AccountTopNav } from "./account-topnav";
import { AccountThemeScript } from "./account-theme";
import type { Customer } from "@/lib/account/user-types";

export function AccountShell({
  initialCustomer,
  children,
}: {
  initialCustomer: Customer;
  children: ReactNode;
}) {
  return (
    <AccountProvider initialCustomer={initialCustomer}>
      <AccountThemeScript />
      <div className="account-app">
        <AccountTopNav />
        <main className="account-main">
          <div className="account-wrap">{children}</div>
        </main>
      </div>
      <Toaster richColors />
    </AccountProvider>
  );
}
