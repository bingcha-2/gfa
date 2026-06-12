"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboardIcon,
  CreditCardIcon,
  MonitorSmartphoneIcon,
  BarChart2Icon,
  MessageSquareIcon,
  BellIcon,
  DownloadIcon,
  SettingsIcon,
  LogOutIcon,
  ChevronDownIcon,
  MenuIcon,
  XIcon,
} from "lucide-react";

import { useAccount } from "./account-provider";
import { AccountThemeToggle } from "./account-theme";
import { getNotifications } from "@/lib/account/user-api";
import { useDict } from "@/lib/i18n/client";

type NavKey =
  | "overview"
  | "billing"
  | "devices"
  | "usage"
  | "referral"
  | "tickets"
  | "notifications"
  | "download"
  | "settings";

type NavItem = { id: NavKey; url: string; icon: React.ReactNode };

// 邀请返佣已下线(/account/referral 重定向到首页),不再放入导航。
const PRIMARY: NavItem[] = [
  { id: "overview", url: "/account", icon: <LayoutDashboardIcon className="size-4" /> },
  { id: "billing", url: "/account/billing", icon: <CreditCardIcon className="size-4" /> },
  { id: "devices", url: "/account/devices", icon: <MonitorSmartphoneIcon className="size-4" /> },
  { id: "usage", url: "/account/usage", icon: <BarChart2Icon className="size-4" /> },
  { id: "tickets", url: "/account/tickets", icon: <MessageSquareIcon className="size-4" /> },
];

// In the user menu (notifications is the bell; referral is offline).
const SECONDARY: NavItem[] = [
  { id: "download", url: "/account/download", icon: <DownloadIcon className="size-4" /> },
  { id: "settings", url: "/account/settings", icon: <SettingsIcon className="size-4" /> },
];

/** One-shot unread count for the bell — no polling. */
function useUnreadCount(): number {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    getNotifications(1, 1)
      .then((page) => setUnread(page.unread))
      .catch(() => {});
  }, []);
  return unread;
}

export function AccountTopNav() {
  const pathname = usePathname();
  const { customer, handleLogout } = useAccount();
  const dict = useDict();
  const nav = dict.portalApp.nav;
  const t = dict.portalApp;
  const unread = useUnreadCount();

  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close menus on route change.
  useEffect(() => {
    setMenuOpen(false);
    setMobileOpen(false);
  }, [pathname]);

  function isActive(url: string) {
    if (url === "/account") return pathname === "/account";
    return pathname.startsWith(url);
  }

  const displayName = customer.displayName || customer.email;
  const initial = (customer.displayName || customer.email || "·").charAt(0).toUpperCase();

  return (
    <header className="account-topnav" data-scrolled={scrolled || undefined}>
      <div className="account-topnav__inner">
        <Link href="/account" className="account-topnav__brand" aria-label="冰茶AI 用户中心">
          <img src="/bcai-icon.png" alt="" />
          <span>冰茶AI</span>
        </Link>

        <nav className="account-topnav__links" aria-label="账户导航">
          {PRIMARY.map((item) => (
            <Link
              key={item.id}
              href={item.url}
              className="account-topnav__link"
              data-active={isActive(item.url) || undefined}
            >
              {nav[item.id]}
            </Link>
          ))}
        </nav>

        <div className="account-topnav__spacer" />

        <div className="account-topnav__actions">
          <Link
            href="/account/notifications"
            className="account-iconbtn"
            aria-label={nav.notifications}
          >
            <BellIcon />
            {unread > 0 && (
              <span className="account-iconbtn__badge" aria-hidden>
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </Link>

          <AccountThemeToggle />

          <div className="account-usermenu">
            <button
              type="button"
              className="account-usermenu__trigger"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
            >
              <span className="account-usermenu__avatar" aria-hidden>
                {initial}
              </span>
              <span className="account-usermenu__name">{displayName}</span>
              <ChevronDownIcon />
            </button>
            {menuOpen && (
              <>
                <button
                  type="button"
                  aria-hidden
                  onClick={() => setMenuOpen(false)}
                  style={{
                    position: "fixed",
                    inset: 0,
                    zIndex: 110,
                    background: "transparent",
                    border: 0,
                    cursor: "default",
                  }}
                />
                <div className="account-usermenu__content" role="menu">
                  <div className="account-usermenu__head">
                    <b>{displayName}</b>
                    <span>● {customer.email}</span>
                  </div>
                  {SECONDARY.map((item) => (
                    <Link key={item.id} href={item.url} role="menuitem">
                      {item.icon}
                      {nav[item.id]}
                    </Link>
                  ))}
                  <button type="button" onClick={handleLogout} role="menuitem">
                    <LogOutIcon />
                    {t.actions.logout}
                  </button>
                </div>
              </>
            )}
          </div>

          <button
            type="button"
            className="account-iconbtn account-topnav__menu"
            aria-label="打开菜单"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((v) => !v)}
          >
            {mobileOpen ? <XIcon /> : <MenuIcon />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <nav className="account-mobilemenu" aria-label="账户导航">
          {[...PRIMARY, ...SECONDARY].map((item) => (
            <Link
              key={item.id}
              href={item.url}
              className="account-topnav__link"
              data-active={isActive(item.url) || undefined}
            >
              {item.icon}
              {nav[item.id]}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
