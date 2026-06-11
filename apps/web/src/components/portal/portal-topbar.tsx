"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { ChevronDownIcon, LogOutIcon, SettingsIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { usePortal } from "./portal-provider";
import { useDict } from "@/lib/i18n/client";

export function PortalTopbar({ title }: { title?: string }) {
  const { customer, handleLogout } = usePortal();
  const dict = useDict();
  const t = dict.portalApp;

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />

      {title && (
        <h1 className="text-sm font-medium truncate flex-1">{title}</h1>
      )}
      {!title && <div className="flex-1" />}

      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="gap-1.5 h-8" />}>
          <UserIcon className="size-3.5" />
          <span className="max-w-[120px] truncate text-xs">
            {customer.displayName || customer.email}
          </span>
          <ChevronDownIcon className="size-3 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem render={<Link href="/app/settings" />}>
            <SettingsIcon className="size-4 mr-2" />
            {t.nav.settings}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={handleLogout}
            className="text-destructive focus:text-destructive"
          >
            <LogOutIcon className="size-4 mr-2" />
            {t.actions.logout}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
