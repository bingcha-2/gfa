"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { useConsole } from "@/components/console-provider";
import { NavUser } from "@/components/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import {
  LayoutDashboardIcon,
  BarChart3Icon,
  UsersIcon,
  FolderOpenIcon,
  ShoppingCartIcon,
  ListTodoIcon,
  KeyIcon,
  ClockIcon,
  CalendarSyncIcon,
  SearchIcon,
  ShieldIcon,
  Settings2Icon,
  CommandIcon,
  BotIcon,
  HelpCircleIcon,
} from "lucide-react";

const SECTION_PERM_MAP: Record<string, string> = {
  overview: "overview",
  "daily-stats": "daily_stats",
  accounts: "accounts",
  groups: "groups",
  orders: "orders",
  tasks: "tasks",
  codes: "codes",
  expire: "expire",
  scheduler: "scheduler",
  lookup: "lookup",
  "agent-service": "agent_service",
  "rosetta-employees": "agent_service",
  "rosetta-keys": "codes",
  faq: "faq",
};

type NavItem = {
  id: string;
  title: string;
  url: string;
  icon: React.ReactNode;
  metric?: string | number;
  /** Only show this item if the user's role matches */
  roleGuard?: (role: string) => boolean;
  /** Permission key for fine-grained access */
  permKey?: string;
};

function getPrefix() {
  return (
    (process.env.NEXT_PUBLIC_ADMIN_PATH_PREFIX ?? "console").replace(
      /^\/|\/$/g,
      ""
    ) || "console"
  );
}

export function GfaAppSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const { user, stats } = useConsole();
  const pathname = usePathname();
  const prefix = getPrefix();

  const role = String(user.role || "").toUpperCase();
  const isSuperAdmin = role === "SUPER_ADMIN" || role === "SUPERADMIN";
  const isAdmin = role === "ADMIN";
  const isAdminOrOps =
    isSuperAdmin || isAdmin || role === "OPERATIONS";

  const userPerms: string[] | null = (user as any).permissions ?? null;
  function hasPermission(permKey: string): boolean {
    if (isSuperAdmin || isAdmin) return true;
    if (!userPerms || userPerms.length === 0) return true;
    return userPerms.includes(permKey);
  }

  const availableSlots = stats?.availableSlots ?? 0;
  const activeOrders = stats?.activeOrders ?? 0;
  const manualReviewTasks = stats?.manualReviewTasks ?? 0;
  const unusedCodes = stats?.unusedCodes ?? 0;

  const mainNav: NavItem[] = [
    {
      id: "overview",
      title: "总览",
      url: `/${prefix}`,
      icon: <LayoutDashboardIcon />,
      metric: `${activeOrders} 处理中`,
      permKey: "overview",
    },
    {
      id: "daily-stats",
      title: "数据汇总",
      url: `/${prefix}/daily-stats`,
      icon: <BarChart3Icon />,
      permKey: "daily_stats",
    },
    {
      id: "accounts",
      title: "母号池",
      url: `/${prefix}/accounts`,
      icon: <UsersIcon />,
      metric: `${stats?.totals?.accounts ?? 0}`,
      permKey: "accounts",
    },
    {
      id: "groups",
      title: "家庭组",
      url: `/${prefix}/groups`,
      icon: <FolderOpenIcon />,
      metric: `${availableSlots} 空位`,
      permKey: "groups",
    },
    {
      id: "orders",
      title: "订单",
      url: `/${prefix}/orders`,
      icon: <ShoppingCartIcon />,
      metric: `${stats?.totals?.orders ?? 0}`,
      permKey: "orders",
    },
    {
      id: "tasks",
      title: "任务",
      url: `/${prefix}/tasks`,
      icon: <ListTodoIcon />,
      metric: `${manualReviewTasks} 待处理`,
      permKey: "tasks",
    },
    {
      id: "codes",
      title: "卡密",
      url: `/${prefix}/codes`,
      icon: <KeyIcon />,
      metric: `${unusedCodes} 未用`,
      permKey: "codes",
    },
    {
      id: "expire",
      title: "到期扫描",
      url: `/${prefix}/expire`,
      icon: <ClockIcon />,
      permKey: "expire",
    },
  ];

  const managementNav: NavItem[] = [
    {
      id: "scheduler",
      title: "自动维护",
      url: `/${prefix}/scheduler`,
      icon: <CalendarSyncIcon />,
      permKey: "scheduler",
      roleGuard: () => isAdminOrOps,
    },
    {
      id: "lookup",
      title: "成员管理",
      url: `/${prefix}/lookup`,
      icon: <SearchIcon />,
      permKey: "lookup",
    },
    {
      id: "agent-service",
      title: "代理服务",
      url: `/${prefix}/agent-service`,
      icon: <BotIcon />,
      permKey: "agent_service",
      roleGuard: () => isAdminOrOps,
    },
    {
      id: "rosetta-employees",
      title: "Rosetta 员工",
      url: `/${prefix}/rosetta-employees`,
      icon: <UsersIcon />,
      permKey: "agent_service",
      roleGuard: () => isAdminOrOps,
    },
    {
      id: "rosetta-keys",
      title: "Rosetta 卡密",
      url: `/${prefix}/rosetta-keys`,
      icon: <KeyIcon />,
      permKey: "codes",
      roleGuard: () => isAdminOrOps,
    },
    {
      id: "faq",
      title: "常见问题",
      url: `/${prefix}/faq`,
      icon: <HelpCircleIcon />,
      permKey: "faq",
      roleGuard: () => isAdminOrOps,
    },
    {
      id: "users",
      title: "用户管理",
      url: `/${prefix}/users`,
      icon: <ShieldIcon />,
      roleGuard: () => isSuperAdmin,
    },
  ];

  const settingsNav: NavItem[] = [
    {
      id: "settings",
      title: "修改密码",
      url: `/${prefix}/settings`,
      icon: <Settings2Icon />,
    },
  ];

  function filterNav(items: NavItem[]) {
    return items.filter((item) => {
      if (item.roleGuard && !item.roleGuard(user.role)) return false;
      if (item.permKey && !hasPermission(item.permKey)) return false;
      return true;
    });
  }

  function isActive(url: string) {
    if (url === `/${prefix}`) {
      return pathname === `/${prefix}` || pathname === "/console";
    }
    return pathname.startsWith(url);
  }

  function renderNavGroup(label: string, items: NavItem[]) {
    const filtered = filterNav(items);
    if (filtered.length === 0) return null;

    return (
      <SidebarGroup>
        <SidebarGroupLabel>{label}</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {filtered.map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  tooltip={item.title}
                  isActive={isActive(item.url)}
                  render={<Link href={item.url} />}
                >
                  {item.icon}
                  <span>{item.title}</span>
                  {item.metric != null && (
                    <Badge
                      variant="secondary"
                      className="ml-auto text-[10px] px-1.5 py-0"
                    >
                      {item.metric}
                    </Badge>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="data-[slot=sidebar-menu-button]:p-1.5!"
              render={<Link href={`/${prefix}`} />}
            >
              <CommandIcon className="size-5!" />
              <span className="text-base font-semibold">GFA Console</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {renderNavGroup("运营", mainNav)}
        {renderNavGroup("管理", managementNav)}
        {renderNavGroup("设置", settingsNav)}
      </SidebarContent>

      <SidebarFooter>
        <NavUser
          user={{
            name: user.displayName,
            email: user.email,
            avatar: "",
          }}
        />
      </SidebarFooter>
    </Sidebar>
  );
}
