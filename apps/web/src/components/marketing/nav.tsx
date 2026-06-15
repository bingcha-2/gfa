"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Download, Menu, UserRound, X } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";
import { LocaleSwitcher } from "./locale-switcher";
import { useDict } from "@/lib/i18n/client";
import { ACCOUNT_URL } from "@/lib/account/portal-url";

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
            className="mkt-btn mkt-btn--ghost mkt-btn--sm"
          >
            <UserRound aria-hidden />
            {t.common.userCenter}
          </a>
          <a href="/download" className="mkt-btn mkt-btn--primary mkt-btn--sm">
            <Download aria-hidden />
            {t.common.downloadClient}
          </a>
          <button
            type="button"
            className="mkt-iconbtn mkt-menubtn"
            aria-label={t.nav.menu}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X aria-hidden /> : <Menu aria-hidden />}
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
          <a
            href="/download"
            className="mkt-nav__link"
            onClick={() => setOpen(false)}
          >
            {t.common.downloadClient}
          </a>
        </div>
      )}
    </header>
  );
}
