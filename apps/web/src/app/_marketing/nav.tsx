"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "./theme-toggle";

const LINKS = [
  { href: "/features", label: "客户端功能" },
  { href: "/how-it-works", label: "工作原理" },
  { href: "/quickstart", label: "快速开始" },
  { href: "/faq", label: "常见问题" },
];

const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
  </svg>
);

export function MarketingNav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const active = (href: string) => pathname === href;

  return (
    <header className="mkt-nav" data-scrolled={scrolled}>
      <div className="mkt-nav__inner">
        <a href="/" className="mkt-brand">
          <img className="mkt-brand__mark" src="/bcai-icon.png" alt="冰茶AI" width={30} height={30} />
          冰茶AI
        </a>

        <nav className="mkt-nav__links" aria-label="主导航">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className="mkt-nav__link" data-active={active(l.href)}>
              {l.label}
            </a>
          ))}
        </nav>

        <span className="mkt-nav__spacer" />

        <div className="mkt-nav__actions">
          <ThemeToggle />
          <a
            href="https://bcai.store"
            target="_blank"
            rel="noopener noreferrer"
            className="mkt-btn mkt-btn--ghost mkt-btn--sm mkt-nav__buy"
          >
            购买卡密 ↗
          </a>
          <a href="/download" className="mkt-btn mkt-btn--primary mkt-btn--sm">
            <DownloadIcon />
            下载客户端
          </a>
          <button
            type="button"
            className="mkt-iconbtn mkt-menubtn"
            aria-label="菜单"
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
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className="mkt-nav__link" data-active={active(l.href)} onClick={() => setOpen(false)}>
              {l.label}
            </a>
          ))}
          <a
            href="https://bcai.store"
            target="_blank"
            rel="noopener noreferrer"
            className="mkt-nav__link"
            onClick={() => setOpen(false)}
          >
            购买卡密 ↗
          </a>
        </div>
      )}
    </header>
  );
}
