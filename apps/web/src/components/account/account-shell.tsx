"use client";

import type { ReactNode } from "react";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { AccountProvider } from "./account-provider";
import { AccountSidebar } from "./account-sidebar";
import { AccountTopbar } from "./account-topbar";
import type { Customer } from "@/lib/account/user-types";

export function AccountShell({
  initialCustomer,
  title,
  children,
}: {
  initialCustomer: Customer;
  title?: string;
  children: ReactNode;
}) {
  return (
    <AccountProvider initialCustomer={initialCustomer}>
      <SidebarProvider
        style={
          {
            "--sidebar-width": "calc(var(--spacing) * 56)",
            "--header-height": "calc(var(--spacing) * 12)",
          } as React.CSSProperties
        }
      >
        <AccountSidebar />
        <SidebarInset>
          <AccountTopbar title={title} />
          <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
            <div className="flex flex-1 flex-col gap-4 p-4 lg:p-6 min-w-0">
              {children}
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Toaster richColors />
    </AccountProvider>
  );
}
