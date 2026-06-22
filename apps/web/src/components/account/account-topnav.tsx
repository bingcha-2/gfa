"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboardIcon,
  CreditCardIcon,
  BarChart2Icon,
  MessageSquareIcon,
  BellIcon,
  GiftIcon,
  DownloadIcon,
  UserRoundIcon,
  LogOutIcon,
  ChevronDownIcon,
  MenuIcon,
  XIcon,
} from "lucide-react";

import { useAccount } from "./account-provider";
import { AccountThemeToggle } from "./account-theme";
import { AccountLocaleSwitcher } from "./account-locale-switcher";
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
  | "settings"
  | "me";

type NavItem = { id: NavKey; url: string; icon: React.ReactNode };

// 设备与设置(改密码/退出)已并入最右侧的「我的」中心(/account/me)。
const PRIMARY: NavItem[] = [
  { id: "overview", url: "/account", icon: <LayoutDashboardIcon className="size-4" /> },
  { id: "billing", url: "/account/billing", icon: <CreditCardIcon className="size-4" /> },
  { id: "usage", url: "/account/usage", icon: <BarChart2Icon className="size-4" /> },
  { id: "referral", url: "/account/referral", icon: <GiftIcon className="size-4" /> },
  { id: "tickets", url: "/account/tickets", icon: <MessageSquareIcon className="size-4" /> },
  { id: "me", url: "/account/me", icon: <UserRoundIcon className="size-4" /> },
];

// In the user menu (notifications is the bell; referral is offline).
const SECONDARY: NavItem[] = [
  { id: "download", url: "/account/download", icon: <DownloadIcon className="size-4" /> },
];

export function AccountTopNav() {
  const pathname = usePathname();
  const { customer, handleLogout, unread } = useAccount();
  const dict = useDict();
  const nav = dict.portalApp.nav;
  const t = dict.portalApp;

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
  const initial = (customer.displayName || customer.email || "?").charAt(0).toUpperCase();

  return (
    <>
      <aside className="account-rail" data-scrolled={scrolled || undefined}>
        <Link href="/account" className="account-rail__brand" aria-label={nav.brandAria}>
          <img src="/bcai-icon.png" alt="" />
          <span>
            {dict.common.brandName}
            <small>ACCOUNT</small>
          </span>
        </Link>

        <nav className="account-rail__nav" aria-label={nav.navAria}>
          {PRIMARY.map((item) => (
            <Link
              key={item.id}
              href={item.url}
              className="account-rail__link"
              data-active={isActive(item.url) || undefined}
            >
              {item.icon}
              {nav[item.id]}
            </Link>
          ))}
        </nav>

        <div className="account-rail__footer">
          {SECONDARY.map((item) => (
            <Link
              key={item.id}
              href={item.url}
              className="account-rail__link account-rail__link--muted"
              data-active={isActive(item.url) || undefined}
            >
              {item.icon}
              {nav[item.id]}
            </Link>
          ))}
        </div>
      </aside>

      <header className="account-actionbar" data-scrolled={scrolled || undefined}>
        <div className="account-actionbar__inner">
          <Link href="/account" className="account-actionbar__brand" aria-label={nav.brandAria}>
            <img src="/bcai-icon.png" alt="" />
            <span>{dict.common.brandName}</span>
          </Link>

          <div className="account-actionbar__spacer" />

          <div className="account-actionbar__actions">
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

            <AccountLocaleSwitcher />

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
              aria-label={nav.openMenu}
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen((v) => !v)}
            >
              {mobileOpen ? <XIcon /> : <MenuIcon />}
            </button>
          </div>
        </div>

        {mobileOpen && (
          <nav className="account-mobilemenu" aria-label={nav.navAria}>
            {[...PRIMARY, ...SECONDARY].map((item) => (
              <Link
                key={item.id}
                href={item.url}
                className="account-rail__link"
                data-active={isActive(item.url) || undefined}
              >
                {item.icon}
                {nav[item.id]}
              </Link>
            ))}
          </nav>
        )}
      </header>
    </>
  );
}
