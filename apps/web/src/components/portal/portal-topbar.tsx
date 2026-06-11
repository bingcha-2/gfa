"use client";

import { useEffect, useState } from "react";
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
import {
  BellIcon,
  ChevronDownIcon,
  LogOutIcon,
  SettingsIcon,
  UserIcon,
} from "lucide-react";
import Link from "next/link";
import { usePortal } from "./portal-provider";
import { getNotifications } from "@/lib/user-api";
import { useDict } from "@/lib/i18n/client";

/** Light one-shot unread count for the bell — no polling. */
function useUnreadCount(): number {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    getNotifications(1, 1)
      .then((page) => setUnread(page.unread))
      .catch(() => {
        // Bell stays plain on failure — never block the topbar.
      });
  }, []);
  return unread;
}

export function PortalTopbar({ title }: { title?: string }) {
  const { customer, handleLogout } = usePortal();
  const dict = useDict();
  const t = dict.portalApp;
  const unread = useUnreadCount();

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />

      {title && (
        <h1 className="text-sm font-medium truncate flex-1">{title}</h1>
      )}
      {!title && <div className="flex-1" />}

      <Button
        variant="ghost"
        size="icon-sm"
        className="relative"
        nativeButton={false}
        render={
          <Link href="/app/notifications" aria-label={t.nav.notifications} />
        }
      >
        <BellIcon className="size-4" />
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 flex size-3.5 items-center justify-center rounded-full bg-accent text-[9px] font-semibold leading-none text-accent-foreground tabular-nums"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </Button>

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
