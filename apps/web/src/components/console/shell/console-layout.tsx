"use client";

import type { ReactNode } from "react";

import { ConsoleProvider } from "@/components/console/shell/console-provider";
import { ConsoleSidebar } from "@/components/console/shell/console-sidebar";
import { ConsoleHeader } from "@/components/console/shell/console-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import type { SessionUser } from "@/lib/console/types";

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
        <ConsoleSidebar />
        <SidebarInset>
          <ConsoleHeader />
          <div className="flex flex-1 flex-col min-w-0 overflow-hidden bg-muted/60">
            <div className="flex flex-1 flex-col gap-4 p-4 lg:p-6 min-w-0">
              {children}
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Toaster richColors />
    </ConsoleProvider>
  );
}
