"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { cn } from "@/lib/utils";
import { useConsole } from "@/components/console/shell/console-provider";
import { NavUser } from "@/components/console/shell/nav-user";
import { Sidebar } from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
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
  HouseIcon,
  BoxesIcon,
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
  roleGuard?: (role: string) => boolean;
  permKey?: string;
};

type NavSubGroup = { label: string; items: NavItem[] };

/** A rail domain: an icon-rail entry whose contextual panel lists its pages. */
type Domain = {
  id: string;
  /** Full name shown as the panel title. */
  label: string;
  /** 2-char name shown in the narrow icon rail (avoids wrapping). */
  short: string;
  icon: React.ReactNode;
  /** Flat page list (most domains). */
  items?: NavItem[];
  /** Sub-grouped pages (产品账户 by provider). */
  groups?: NavSubGroup[];
};

const STORE_KEY = "console.nav.domain";

function getPrefix() {
  return (
    (process.env.NEXT_PUBLIC_ADMIN_PATH_PREFIX ?? "console").replace(/^\/|\/$/g, "") ||
    "console"
  );
}

export function ConsoleSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { user, stats } = useConsole();
  const pathname = usePathname();
  const router = useRouter();
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
    if (url === `/${prefix}`) return pathname === `/${prefix}` || pathname === "/console";
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

  // ─── Domain page definitions ────────────────────────────────────────────
  const overviewItems: NavItem[] = [
    { id: "overview", title: "总览", url: `/${prefix}`, icon: <LayoutDashboardIcon />, metric: `${activeOrders} 处理中`, permKey: "overview" },
  ];

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
        { id: "anthropic-web-accounts", title: "白号池", url: `/${prefix}/anthropic-web-accounts`, icon: <DatabaseIcon />, permKey: "agent_service", roleGuard: () => isAdminOrOps },
      ],
    },
    {
      label: "共享",
      items: [
        { id: "usage-stats", title: "用量与剩余", url: `/${prefix}/usage-stats`, icon: <ActivityIcon />, permKey: "agent_service", roleGuard: () => isAdminOrOps },
        { id: "activation-codes", title: "激活码管理", url: `/${prefix}/activation-codes`, icon: <KeyIcon />, permKey: "codes", roleGuard: () => isAdminOrOps },
        { id: "plan-catalog", title: "套餐配置", url: `/${prefix}/plan-catalog`, icon: <PackageIcon />, permKey: "plans", roleGuard: () => isAdminOrOps },
      ],
    },
  ];

  const customerItems: NavItem[] = [
    { id: "customers", title: "客户账户", url: `/${prefix}/customers`, icon: <CircleUserIcon />, permKey: "customers", roleGuard: () => isAdminOrOps },
    { id: "plan-orders", title: "订单", url: `/${prefix}/plan-orders`, icon: <ReceiptIcon />, permKey: "billing_orders", roleGuard: () => isAdminOrOps },
    { id: "subscriptions", title: "订阅", url: `/${prefix}/subscriptions`, icon: <RefreshCwIcon />, permKey: "subscriptions", roleGuard: () => isAdminOrOps },
    { id: "tickets", title: "工单", url: `/${prefix}/tickets`, icon: <MessageSquareIcon />, permKey: "tickets", roleGuard: () => isAdminOrOps },
    { id: "referrals", title: "返佣", url: `/${prefix}/referrals`, icon: <GiftIcon />, permKey: "referrals", roleGuard: () => isAdminOrOps },
  ];

  const familyItems: NavItem[] = [
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

  const systemItems: NavItem[] = [
    { id: "users", title: "后台管理员", url: `/${prefix}/users`, icon: <ShieldIcon />, roleGuard: () => isSuperAdmin },
    { id: "announcement", title: "公告管理", url: `/${prefix}/announcement`, icon: <MegaphoneIcon />, permKey: "announcement", roleGuard: () => isAdminOrOps },
    { id: "faq", title: "常见问题", url: `/${prefix}/faq`, icon: <HelpCircleIcon />, permKey: "faq", roleGuard: () => isAdminOrOps },
    { id: "support-knowledge", title: "客服知识", url: `/${prefix}/support-knowledge`, icon: <BotIcon />, permKey: "tickets", roleGuard: () => isAdminOrOps },
    { id: "support-insights", title: "客服分析", url: `/${prefix}/support-insights`, icon: <BarChart3Icon />, permKey: "tickets", roleGuard: () => isAdminOrOps },
    { id: "settings", title: "修改密码", url: `/${prefix}/settings`, icon: <Settings2Icon /> },
  ];

  // ─── Assemble visible domains (drop any with zero visible pages) ─────────
  const domains: Domain[] = React.useMemo(() => {
    const all: Domain[] = [
      { id: "overview", label: "总览", short: "总览", icon: <LayoutDashboardIcon />, items: filterNav(overviewItems) },
      {
        // 供给侧(号池)+ 需求侧(客户)合并为一盘业务。
        id: "business",
        label: "产品与客户",
        short: "业务",
        icon: <BoxesIcon />,
        groups: [
          ...productGroups.map((g) => ({ label: g.label, items: filterNav(g.items) })),
          { label: "客户", items: filterNav(customerItems) },
        ].filter((g) => g.items.length > 0),
      },
      { id: "family", label: "家庭组", short: "家庭", icon: <HouseIcon />, items: filterNav(familyItems) },
      { id: "system", label: "系统", short: "系统", icon: <Settings2Icon />, items: filterNav(systemItems) },
    ];
    return all.filter((d) => (d.items?.length ?? 0) > 0 || (d.groups?.length ?? 0) > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, user.role, JSON.stringify(userPerms), JSON.stringify(stats)]);

  function domainLeaves(d: Domain): NavItem[] {
    return d.groups ? d.groups.flatMap((g) => g.items) : (d.items ?? []);
  }

  // Domain that owns the current route (drives auto-select + active highlight).
  const routeDomainId = domains.find((d) => domainLeaves(d).some((i) => isActive(i.url)))?.id;

  // Initialize from the route only (SSR-safe; no localStorage read during render
  // to avoid a server/client hydration mismatch).
  const [selectedId, setSelectedId] = React.useState<string>(
    () => routeDomainId ?? domains[0]?.id ?? "overview"
  );

  // After mount: if the route doesn't pin a domain, restore the last-used one.
  React.useEffect(() => {
    if (routeDomainId) return;
    const stored = window.localStorage.getItem(STORE_KEY);
    if (stored && domains.some((d) => d.id === stored)) setSelectedId(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the route when the user navigates into another domain's page.
  React.useEffect(() => {
    if (routeDomainId && routeDomainId !== selectedId) setSelectedId(routeDomainId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeDomainId]);

  function selectDomain(id: string) {
    setSelectedId(id);
    if (typeof window !== "undefined") window.localStorage.setItem(STORE_KEY, id);
  }

  const selected = domains.find((d) => d.id === selectedId) ?? domains[0];

  // ─── ⌘K command palette over every page ─────────────────────────────────
  const [cmdOpen, setCmdOpen] = React.useState(false);
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function go(url: string) {
    setCmdOpen(false);
    router.push(url);
  }

  function ItemRow({ item }: { item: NavItem }) {
    const active = isActive(item.url);
    return (
      <Link
        href={item.url}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent",
          active && "bg-sidebar-accent font-medium text-sidebar-foreground"
        )}
      >
        <span className="[&_svg]:size-4 shrink-0 text-sidebar-foreground/60">{item.icon}</span>
        <span className="flex-1 truncate">{item.title}</span>
        {item.metric != null && (
          <Badge variant="secondary" className="ml-auto text-[10px] px-1.5 py-0">
            {item.metric}
          </Badge>
        )}
      </Link>
    );
  }

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <div className="flex h-full w-full">
        {/* Icon rail — one entry per domain */}
        <nav
          aria-label="领域导航"
          className="flex w-16 shrink-0 flex-col items-center gap-1 border-r border-sidebar-border bg-sidebar py-2"
        >
          <Link
            href={`/${prefix}`}
            className="mb-1 flex size-9 items-center justify-center rounded-md text-sidebar-foreground"
            aria-label="GFA Console"
          >
            <CommandIcon className="size-5" />
          </Link>
          {domains.map((d) => {
            const active = d.id === selectedId;
            return (
              <button
                key={d.id}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => selectDomain(d.id)}
                title={d.label}
                className={cn(
                  "flex w-14 flex-col items-center gap-1.5 rounded-lg py-2.5 text-[11px] transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                )}
              >
                <span className="[&_svg]:size-5">{d.icon}</span>
                <span className="whitespace-nowrap leading-none">{d.short}</span>
              </button>
            );
          })}
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setCmdOpen(true)}
            aria-label="搜索 (⌘K)"
            className="flex w-14 flex-col items-center gap-1.5 rounded-lg py-2.5 text-[11px] text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
          >
            <SearchIcon className="size-5" />
            <span className="whitespace-nowrap leading-none">搜索</span>
          </button>
        </nav>

        {/* Contextual panel — only the selected domain's pages */}
        <div className="flex min-w-0 flex-1 flex-col bg-sidebar">
          <div className="px-3 pb-1 pt-3 text-sm font-medium text-sidebar-foreground">
            {selected?.label}
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {selected?.groups
              ? selected.groups.map((g) => (
                  <div key={g.label}>
                    <div className="mt-1.5 mb-0.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/45">
                      {g.label}
                    </div>
                    {g.items.map((item) => (
                      <ItemRow key={item.id} item={item} />
                    ))}
                  </div>
                ))
              : (selected?.items ?? []).map((item) => <ItemRow key={item.id} item={item} />)}
          </div>
          <div className="border-t border-sidebar-border p-2">
            <NavUser user={{ name: user.displayName, email: user.email, avatar: "" }} />
          </div>
        </div>
      </div>

      <CommandDialog open={cmdOpen} onOpenChange={setCmdOpen} title="搜索页面" description="跳转到任意页面">
        <CommandInput placeholder="搜索页面…" />
        <CommandList>
          <CommandEmpty>没有匹配的页面</CommandEmpty>
          {domains.map((d) => (
            <CommandGroup key={d.id} heading={d.label}>
              {domainLeaves(d).map((item) => (
                <CommandItem
                  key={item.id}
                  value={`${d.label} ${item.title}`}
                  onSelect={() => go(item.url)}
                >
                  <span className="[&_svg]:size-4 mr-2 text-muted-foreground">{item.icon}</span>
                  {item.title}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>
    </Sidebar>
  );
}
