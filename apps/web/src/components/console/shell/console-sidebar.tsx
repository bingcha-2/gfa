"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import { useConsole } from "@/components/console/shell/console-provider";
import { NavUser } from "@/components/console/shell/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
} from "@/components/ui/sidebar";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
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
  MegaphoneIcon,
  ShieldAlertIcon,
  ActivityIcon,
  DatabaseIcon,
  MonitorSmartphoneIcon,
  ChevronRightIcon,
  HouseIcon,
  BoxesIcon,
  UserCogIcon,
  CircleUserIcon,
  PackageIcon,
  ReceiptIcon,
  RefreshCwIcon,
  MessageSquareIcon,
  GiftIcon,
} from "lucide-react";

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

type NavSubGroup = { label: string; items: NavItem[] };

function getPrefix() {
  return (
    (process.env.NEXT_PUBLIC_ADMIN_PATH_PREFIX ?? "console").replace(
      /^\/|\/$/g,
      ""
    ) || "console"
  );
}

export function ConsoleSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const { user, stats } = useConsole();
  const pathname = usePathname();
  const prefix = getPrefix();

  const role = String(user.role || "").toUpperCase();
  const isSuperAdmin = role === "SUPER_ADMIN" || role === "SUPERADMIN";
  const isAdmin = role === "ADMIN";
  const isAdminOrOps = isSuperAdmin || isAdmin || role === "OPERATIONS";

  const userPerms: string[] | null = (user as any).permissions ?? null;
  function hasPermission(permKey: string): boolean {
    if (isSuperAdmin || isAdmin) return true;
    if (!userPerms || userPerms.length === 0) return true;
    return userPerms.includes(permKey);
  }

  function isActive(url: string) {
    if (url === `/${prefix}`) {
      return pathname === `/${prefix}` || pathname === "/console";
    }
    return pathname.startsWith(url);
  }

  function filterNav(items: NavItem[]) {
    return items.filter((item) => {
      if (item.roleGuard && !item.roleGuard(user.role)) return false;
      if (item.permKey && !hasPermission(item.permKey)) return false;
      return true;
    });
  }

  const availableSlots = stats?.availableSlots ?? 0;
  const activeOrders = stats?.activeOrders ?? 0;
  const manualReviewTasks = stats?.manualReviewTasks ?? 0;
  const unusedCodes = stats?.unusedCodes ?? 0;

  // ─── 总览（置顶，单项）───────────────────────────────────────────
  const overviewItem: NavItem = {
    id: "overview",
    title: "总览",
    url: `/${prefix}`,
    icon: <LayoutDashboardIcon />,
    metric: `${activeOrders} 处理中`,
    permKey: "overview",
  };

  // ─── 家庭组（Google 拼车业务）──────────────────────────────────────
  const familyNav: NavItem[] = [
    { id: "accounts", title: "母号池", url: `/${prefix}/accounts`, icon: <UsersIcon />, metric: `${stats?.totals?.accounts ?? 0}`, permKey: "accounts" },
    { id: "groups", title: "家庭组", url: `/${prefix}/groups`, icon: <FolderOpenIcon />, metric: `${availableSlots} 空位`, permKey: "groups" },
    { id: "orders", title: "订单", url: `/${prefix}/orders`, icon: <ShoppingCartIcon />, metric: `${stats?.totals?.orders ?? 0}`, permKey: "orders" },
    { id: "tasks", title: "任务", url: `/${prefix}/tasks`, icon: <ListTodoIcon />, metric: `${manualReviewTasks} 待处理`, permKey: "tasks" },
    { id: "codes", title: "卡密", url: `/${prefix}/codes`, icon: <KeyIcon />, metric: `${unusedCodes} 未用`, permKey: "codes" },
    { id: "expire", title: "到期扫描", url: `/${prefix}/expire`, icon: <ClockIcon />, permKey: "expire" },
    { id: "lookup", title: "成员管理", url: `/${prefix}/lookup`, icon: <SearchIcon />, permKey: "lookup" },
    { id: "scheduler", title: "自动维护", url: `/${prefix}/scheduler`, icon: <CalendarSyncIcon />, permKey: "scheduler", roleGuard: () => isAdminOrOps },
    { id: "daily-stats", title: "数据汇总", url: `/${prefix}/daily-stats`, icon: <BarChart3Icon />, permKey: "daily_stats" },
    { id: "bulk-2fa", title: "批量修改 2FA", url: `/${prefix}/bulk-2fa`, icon: <ShieldIcon />, roleGuard: () => isAdminOrOps },
    { id: "agent-service", title: "代理服务", url: `/${prefix}/agent-service`, icon: <BotIcon />, permKey: "agent_service", roleGuard: () => isAdminOrOps },
  ];

  // ─── 产品账户管理（AI 供给侧，按 provider 分子组）────────────────────
  const productGroups: NavSubGroup[] = [
    {
      label: "Antigravity",
      items: [
        { id: "rosetta-load", title: "负载看板", url: `/${prefix}/rosetta-load`, icon: <ActivityIcon />, permKey: "agent_service", roleGuard: () => isAdminOrOps },
        { id: "rosetta-accounts", title: "账号池", url: `/${prefix}/rosetta-accounts`, icon: <DatabaseIcon />, permKey: "agent_service", roleGuard: () => isAdminOrOps },
        { id: "rosetta-captcha", title: "人机解封", url: `/${prefix}/rosetta-captcha`, icon: <ShieldAlertIcon />, permKey: "agent_service", roleGuard: () => isAdminOrOps },
        { id: "rosetta-adspower", title: "AdsPower 录入", url: `/${prefix}/rosetta-adspower`, icon: <MonitorSmartphoneIcon />, permKey: "agent_service", roleGuard: () => isAdminOrOps },
        { id: "rosetta-employees", title: "员工管理", url: `/${prefix}/rosetta-employees`, icon: <UsersIcon />, permKey: "agent_service", roleGuard: () => isAdminOrOps },
        { id: "rosetta-cliproxy", title: "CLIProxy 管理", url: `/${prefix}/rosetta-cliproxy`, icon: <BotIcon />, permKey: "agent_service", roleGuard: () => isAdminOrOps },
      ],
    },
    {
      label: "Codex",
      items: [
        { id: "codex-proxy", title: "负载看板", url: `/${prefix}/codex-proxy`, icon: <ActivityIcon />, permKey: "agent_service", roleGuard: () => isAdminOrOps },
        { id: "codex-accounts", title: "账号池", url: `/${prefix}/codex-accounts`, icon: <DatabaseIcon />, permKey: "agent_service", roleGuard: () => isAdminOrOps },
      ],
    },
    {
      label: "Anthropic",
      items: [
        { id: "anthropic-accounts", title: "账号池", url: `/${prefix}/anthropic-accounts`, icon: <DatabaseIcon />, permKey: "agent_service", roleGuard: () => isAdminOrOps },
      ],
    },
    {
      label: "共享",
      items: [
        { id: "usage-stats", title: "用量与剩余", url: `/${prefix}/usage-stats`, icon: <ActivityIcon />, permKey: "agent_service", roleGuard: () => isAdminOrOps },
        { id: "rosetta-keys", title: "卡密管理", url: `/${prefix}/rosetta-keys`, icon: <KeyIcon />, permKey: "codes", roleGuard: () => isAdminOrOps },
        { id: "plan-catalog", title: "套餐配置", url: `/${prefix}/plan-catalog`, icon: <PackageIcon />, permKey: "plans", roleGuard: () => isAdminOrOps },
      ],
    },
  ];

  // ─── 用户管理（客户业务，需求侧）─────────────────────────────────────
  const customerNav: NavItem[] = [
    { id: "customers", title: "客户账户", url: `/${prefix}/customers`, icon: <CircleUserIcon />, permKey: "customers", roleGuard: () => isAdminOrOps },
    { id: "plan-orders", title: "订单", url: `/${prefix}/plan-orders`, icon: <ReceiptIcon />, permKey: "billing_orders", roleGuard: () => isAdminOrOps },
    { id: "subscriptions", title: "订阅", url: `/${prefix}/subscriptions`, icon: <RefreshCwIcon />, permKey: "subscriptions", roleGuard: () => isAdminOrOps },
    { id: "tickets", title: "工单", url: `/${prefix}/tickets`, icon: <MessageSquareIcon />, permKey: "tickets", roleGuard: () => isAdminOrOps },
    { id: "referrals", title: "返佣", url: `/${prefix}/referrals`, icon: <GiftIcon />, permKey: "referrals", roleGuard: () => isAdminOrOps },
  ];

  // ─── 系统（平台 / 后台工具，置底平铺）──────────────────────────────
  const systemNav: NavItem[] = [
    { id: "users", title: "后台管理员", url: `/${prefix}/users`, icon: <ShieldIcon />, roleGuard: () => isSuperAdmin },
    { id: "announcement", title: "公告管理", url: `/${prefix}/announcement`, icon: <MegaphoneIcon />, permKey: "announcement", roleGuard: () => isAdminOrOps },
    { id: "faq", title: "常见问题", url: `/${prefix}/faq`, icon: <HelpCircleIcon />, permKey: "faq", roleGuard: () => isAdminOrOps },
    { id: "settings", title: "修改密码", url: `/${prefix}/settings`, icon: <Settings2Icon /> },
  ];

  // Filter once, then derive each section's default-open from the active route.
  const familyItems = filterNav(familyNav);
  const productVisible = productGroups
    .map((g) => ({ label: g.label, items: filterNav(g.items) }))
    .filter((g) => g.items.length > 0);
  const customerItems = filterNav(customerNav);

  const [familyOpen, setFamilyOpen] = React.useState(() =>
    familyItems.some((i) => isActive(i.url))
  );
  const [productOpen, setProductOpen] = React.useState(() =>
    productVisible.some((g) => g.items.some((i) => isActive(i.url)))
  );
  const [customerOpen, setCustomerOpen] = React.useState(() =>
    customerItems.some((i) => isActive(i.url))
  );

  function renderSubItems(items: NavItem[]) {
    return items.map((item) => (
      <SidebarMenuSubItem key={item.id}>
        <SidebarMenuSubButton
          isActive={isActive(item.url)}
          render={<Link href={item.url} />}
        >
          {item.icon}
          <span className="flex-1 truncate">{item.title}</span>
          {item.metric != null && (
            <Badge variant="secondary" className="ml-auto text-[10px] px-1.5 py-0">
              {item.metric}
            </Badge>
          )}
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    ));
  }

  function renderTopButton(
    label: string,
    icon: React.ReactNode,
    open: boolean,
    onToggle: () => void
  ) {
    return (
      <SidebarMenuButton
        tooltip={label}
        aria-expanded={open}
        onClick={onToggle}
        className="cursor-pointer"
      >
        {icon}
        <span className="flex-1 text-left">{label}</span>
        <ChevronRightIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
      </SidebarMenuButton>
    );
  }

  function renderFlatGroup(label: string, items: NavItem[]) {
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
                    <Badge variant="secondary" className="ml-auto text-[10px] px-1.5 py-0">
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

  const showOverview =
    !overviewItem.permKey || hasPermission(overviewItem.permKey);

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
        {showOverview && (
          <SidebarGroup className="py-1">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip={overviewItem.title}
                  isActive={isActive(overviewItem.url)}
                  render={<Link href={overviewItem.url} />}
                >
                  {overviewItem.icon}
                  <span>{overviewItem.title}</span>
                  {overviewItem.metric != null && (
                    <Badge variant="secondary" className="ml-auto text-[10px] px-1.5 py-0">
                      {overviewItem.metric}
                    </Badge>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        )}

        {/* 家庭组 */}
        {familyItems.length > 0 && (
          <Collapsible open={familyOpen} onOpenChange={setFamilyOpen}>
            <SidebarGroup className="py-1">
              <SidebarMenu>
                <SidebarMenuItem>
                  {renderTopButton("家庭组", <HouseIcon />, familyOpen, () =>
                    setFamilyOpen((v) => !v)
                  )}
                  <CollapsibleContent>
                    <SidebarMenuSub>{renderSubItems(familyItems)}</SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          </Collapsible>
        )}

        {/* 产品账户管理 */}
        {productVisible.length > 0 && (
          <Collapsible open={productOpen} onOpenChange={setProductOpen}>
            <SidebarGroup className="py-1">
              <SidebarMenu>
                <SidebarMenuItem>
                  {renderTopButton("产品账户管理", <BoxesIcon />, productOpen, () =>
                    setProductOpen((v) => !v)
                  )}
                  <CollapsibleContent>
                    {productVisible.map((g) => (
                      <div key={g.label}>
                        <div className="px-2 pt-2 pb-0.5 text-[11px] font-medium text-sidebar-foreground/50">
                          {g.label}
                        </div>
                        <SidebarMenuSub>{renderSubItems(g.items)}</SidebarMenuSub>
                      </div>
                    ))}
                  </CollapsibleContent>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          </Collapsible>
        )}

        {/* 用户管理 */}
        {customerItems.length > 0 && (
          <Collapsible open={customerOpen} onOpenChange={setCustomerOpen}>
            <SidebarGroup className="py-1">
              <SidebarMenu>
                <SidebarMenuItem>
                  {renderTopButton("用户管理", <UserCogIcon />, customerOpen, () =>
                    setCustomerOpen((v) => !v)
                  )}
                  <CollapsibleContent>
                    <SidebarMenuSub>{renderSubItems(customerItems)}</SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          </Collapsible>
        )}

        {/* 系统 */}
        {renderFlatGroup("系统", systemNav)}
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
