"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "./theme-toggle";
import { LocaleSwitcher } from "./locale-switcher";
import { useDict } from "@/lib/i18n/client";
import { ACCOUNT_URL } from "@/lib/account/portal-url";

const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
  </svg>
);

const UserIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

export function MarketingNav() {
  const t = useDict();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const links = [
    { href: "/features", label: t.nav.features },
    { href: "/how-it-works", label: t.nav.howItWorks },
    { href: "/quickstart", label: t.nav.quickstart },
    { href: "/faq", label: t.nav.faq },
  ];

  const active = (href: string) => pathname === href;

  return (
    <header className="mkt-nav" data-scrolled={scrolled}>
      <div className="mkt-nav__inner">
        <a href="/" className="mkt-brand">
          <img className="mkt-brand__mark" src="/bcai-icon.png" alt={t.common.brandName} width={30} height={30} />
          {t.common.brandName}
        </a>

        <nav className="mkt-nav__links" aria-label={t.nav.mainNav}>
          {links.map((l) => (
            <a key={l.href} href={l.href} className="mkt-nav__link" data-active={active(l.href)}>
              {l.label}
            </a>
          ))}
        </nav>

        <span className="mkt-nav__spacer" />

        <div className="mkt-nav__actions">
          <LocaleSwitcher />
          <ThemeToggle />
          <a
            href={ACCOUNT_URL}
            className="mkt-btn mkt-btn--ghost mkt-btn--sm mkt-nav__account"
          >
            <UserIcon />
            {t.common.userCenter}
          </a>
          <a href="/download" className="mkt-btn mkt-btn--primary mkt-btn--sm">
            <DownloadIcon />
            {t.common.downloadClient}
          </a>
          <button
            type="button"
            className="mkt-iconbtn mkt-menubtn"
            aria-label={t.nav.menu}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              {open ? <path d="M18 6 6 18M6 6l12 12" /> : <path d="M3 12h18M3 6h18M3 18h18" />}
            </svg>
          </button>
        </div>
      </div>

      {open && (
        <div className="mkt-mobile">
          {links.map((l) => (
            <a key={l.href} href={l.href} className="mkt-nav__link" data-active={active(l.href)} onClick={() => setOpen(false)}>
              {l.label}
            </a>
          ))}
          <a
            href={ACCOUNT_URL}
            className="mkt-nav__link"
            onClick={() => setOpen(false)}
          >
            {t.common.userCenter}
          </a>
        </div>
      )}
    </header>
  );
}
