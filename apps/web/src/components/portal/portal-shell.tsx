"use client";

import type { ReactNode } from "react";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { PortalProvider } from "./portal-provider";
import { PortalSidebar } from "./portal-sidebar";
import { PortalTopbar } from "./portal-topbar";
import type { Customer } from "@/lib/user-types";

export function PortalShell({
  initialCustomer,
  title,
  children,
}: {
  initialCustomer: Customer;
  title?: string;
  children: ReactNode;
}) {
  return (
    <PortalProvider initialCustomer={initialCustomer}>
      <SidebarProvider
        style={
          {
            "--sidebar-width": "calc(var(--spacing) * 56)",
            "--header-height": "calc(var(--spacing) * 12)",
          } as React.CSSProperties
        }
      >
        <PortalSidebar />
        <SidebarInset>
          <PortalTopbar title={title} />
          <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
            <div className="flex flex-1 flex-col gap-4 p-4 lg:p-6 min-w-0">
              {children}
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Toaster richColors />
    </PortalProvider>
  );
}
