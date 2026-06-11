"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboardIcon,
  CreditCardIcon,
  MonitorSmartphoneIcon,
  BarChart2Icon,
  BellIcon,
  MessageSquareIcon,
  GiftIcon,
  DownloadIcon,
  SettingsIcon,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { usePortal } from "./portal-provider";
import { useDict } from "@/lib/i18n/client";

type NavItem = {
  id: string;
  labelKey: keyof ReturnType<typeof useDict>["portalApp"]["nav"];
  url: string;
  icon: React.ReactNode;
};

const NAV_ITEMS: NavItem[] = [
  {
    id: "overview",
    labelKey: "overview",
    url: "/account",
    icon: <LayoutDashboardIcon className="size-4" />,
  },
  {
    id: "billing",
    labelKey: "billing",
    url: "/account/billing",
    icon: <CreditCardIcon className="size-4" />,
  },
  {
    id: "devices",
    labelKey: "devices",
    url: "/account/devices",
    icon: <MonitorSmartphoneIcon className="size-4" />,
  },
  {
    id: "usage",
    labelKey: "usage",
    url: "/account/usage",
    icon: <BarChart2Icon className="size-4" />,
  },
  {
    id: "notifications",
    labelKey: "notifications",
    url: "/account/notifications",
    icon: <BellIcon className="size-4" />,
  },
  {
    id: "tickets",
    labelKey: "tickets",
    url: "/account/tickets",
    icon: <MessageSquareIcon className="size-4" />,
  },
  {
    id: "referral",
    labelKey: "referral",
    url: "/account/referral",
    icon: <GiftIcon className="size-4" />,
  },
  {
    id: "download",
    labelKey: "download",
    url: "/account/download",
    icon: <DownloadIcon className="size-4" />,
  },
  {
    id: "settings",
    labelKey: "settings",
    url: "/account/settings",
    icon: <SettingsIcon className="size-4" />,
  },
];

export function PortalSidebar() {
  const pathname = usePathname();
  const { customer } = usePortal();
  const dict = useDict();
  const nav = dict.portalApp.nav;

  function isActive(url: string) {
    if (url === "/account") return pathname === "/account";
    return pathname.startsWith(url);
  }

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="data-[slot=sidebar-menu-button]:p-1.5!"
              render={<Link href="/account" />}
            >
              <span className="size-5 flex items-center justify-center rounded bg-accent text-accent-foreground text-xs font-bold shrink-0">
                冰
              </span>
              <span className="text-base font-semibold">
                {dict.common.brandName}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    tooltip={nav[item.labelKey]}
                    isActive={isActive(item.url)}
                    render={<Link href={item.url} />}
                  >
                    {item.icon}
                    <span>{nav[item.labelKey]}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="px-3 py-2 text-xs text-muted-foreground truncate">
          {customer.email}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
