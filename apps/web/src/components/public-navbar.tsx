"use client";

/**
 * PublicNavBar — 公开页面统一导航栏
 * 暗色毛玻璃风格，固定顶部，用于 /about、/download、/faq 等页面。
 */

import { usePathname } from "next/navigation";

const NAV_LINKS = [
  { href: "/about", label: "关于" },
  { href: "/download", label: "下载" },
  { href: "/faq", label: "常见问题" },
];

export function PublicNavBar() {
  const pathname = usePathname();

  return (
    <nav
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        height: 56,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(12,10,21,.72)",
        backdropFilter: "blur(16px) saturate(1.4)",
        WebkitBackdropFilter: "blur(16px) saturate(1.4)",
        borderBottom: "1px solid rgba(255,255,255,.06)",
        fontFamily: "var(--font-sans), system-ui, sans-serif",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 960,
          padding: "0 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        {/* Left: Brand */}
        <a
          href="/"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            textDecoration: "none",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "linear-gradient(135deg, #ea580c, #f97316)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 17,
            }}
          >
            🍵
          </span>
          <span
            style={{
              fontSize: 17,
              fontWeight: 800,
              background: "linear-gradient(90deg, #f97316, #fbbf24)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              letterSpacing: "-0.02em",
            }}
          >
            冰茶AI
          </span>
        </a>

        {/* Center: Links */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {NAV_LINKS.map((link) => {
            const isActive = pathname === link.href;
            return (
              <a
                key={link.href}
                href={link.href}
                style={{
                  padding: "6px 14px",
                  borderRadius: 8,
                  fontSize: 14,
                  fontWeight: isActive ? 600 : 500,
                  color: isActive ? "rgba(255,255,255,.95)" : "rgba(255,255,255,.5)",
                  background: isActive ? "rgba(255,255,255,.08)" : "transparent",
                  textDecoration: "none",
                  transition: "all .15s",
                }}
                onMouseOver={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,.8)";
                    (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,.05)";
                  }
                }}
                onMouseOut={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,.5)";
                    (e.currentTarget as HTMLElement).style.background = "transparent";
                  }
                }}
              >
                {link.label}
              </a>
            );
          })}
        </div>

        {/* Right: CTA */}
        <a
          href="/download"
          style={{
            padding: "7px 16px",
            borderRadius: 8,
            background: "linear-gradient(135deg, #ea580c, #f97316)",
            color: "#fff",
            fontWeight: 600,
            fontSize: 13,
            textDecoration: "none",
            transition: "opacity .15s",
            flexShrink: 0,
          }}
          onMouseOver={(e) => {
            (e.currentTarget as HTMLElement).style.opacity = "0.85";
          }}
          onMouseOut={(e) => {
            (e.currentTarget as HTMLElement).style.opacity = "1";
          }}
        >
          ⬇ 下载
        </a>
      </div>
    </nav>
  );
}
