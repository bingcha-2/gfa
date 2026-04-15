"use client";

import type { ReactNode } from "react";

import { ConsoleProvider } from "@/components/console-provider";
import { GfaAppSidebar } from "@/components/gfa-app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import type { SessionUser } from "@/lib/types";

export function ConsoleLayout({
  initialUser,
  initialStats,
  children,
}: {
  initialUser: SessionUser;
  initialStats: any;
  children: ReactNode;
}) {
  return (
    <ConsoleProvider initialUser={initialUser} initialStats={initialStats}>
      <SidebarProvider
        style={
          {
            "--sidebar-width": "calc(var(--spacing) * 72)",
            "--header-height": "calc(var(--spacing) * 12)",
          } as React.CSSProperties
        }
      >
        <GfaAppSidebar variant="inset" />
        <SidebarInset>
          <SiteHeader />
          <div className="flex flex-1 flex-col">
            <div className="flex flex-1 flex-col gap-4 p-4 lg:p-6">
              {children}
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Toaster richColors />
    </ConsoleProvider>
  );
}
