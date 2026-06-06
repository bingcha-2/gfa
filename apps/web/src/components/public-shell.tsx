"use client";

/**
 * PublicShell — 公开页面布局（左侧导航栏 + 右侧内容区）
 * 参考 Mintlify almond 主题，微灰暖白底色
 */

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const NAV_GROUPS = [
  {
    title: "开始",
    items: [
      { href: "/", label: "简介" },
      { href: "/quickstart", label: "快速开始" },
      { href: "/how-it-works", label: "工作原理" },
    ],
  },
  {
    title: "产品",
    items: [
      { href: "/features", label: "客户端功能" },
      { href: "/download", label: "下载客户端" },
    ],
  },
  {
    title: "帮助",
    items: [
      { href: "/faq", label: "常见问题" },
    ],
  },
];

const EXTERNAL_LINKS = [
  { href: "https://bcai.store", label: "冰茶商店", icon: "↗" },
];

function Sidebar() {
  const pathname = usePathname();

  return (
    <aside
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        bottom: 0,
        width: 260,
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid rgba(0,0,0,.07)",
        background: "rgba(250,249,248,.92)",
        zIndex: 50,
        fontFamily: "var(--font-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
      }}
    >
      {/* Brand */}
      <div style={{ padding: "20px 20px 16px" }}>
        <a
          href="/"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            textDecoration: "none",
          }}
        >
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              background: "linear-gradient(135deg, #ea580c, #f97316)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 14,
              boxShadow: "0 2px 6px rgba(234,88,12,.15)",
            }}
          >
            🍵
          </span>
          <span
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: "#1a1a1a",
              letterSpacing: "-0.01em",
            }}
          >
            冰茶AI
          </span>
        </a>
      </div>

      {/* Navigation */}
      <nav style={{ flex: 1, overflowY: "auto", padding: "4px 10px" }}>
        {NAV_GROUPS.map((group) => (
          <div key={group.title} style={{ marginBottom: 24 }}>
            <div
              style={{
                padding: "0 12px",
                marginBottom: 4,
                fontSize: 11,
                fontWeight: 600,
                color: "rgba(0,0,0,.35)",
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
            >
              {group.title}
            </div>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {group.items.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <li key={item.href}>
                    <a
                      href={item.href}
                      style={{
                        display: "block",
                        padding: "6px 12px",
                        borderRadius: 8,
                        fontSize: 14,
                        fontWeight: isActive ? 600 : 400,
                        color: isActive ? "#ea580c" : "rgba(0,0,0,.55)",
                        background: isActive ? "rgba(234,88,12,.07)" : "transparent",
                        textDecoration: "none",
                        transition: "all .1s ease",
                        lineHeight: 1.5,
                      }}
                      onMouseOver={(e) => {
                        if (!isActive) {
                          (e.currentTarget as HTMLElement).style.background = "rgba(0,0,0,.04)";
                          (e.currentTarget as HTMLElement).style.color = "rgba(0,0,0,.8)";
                        }
                      }}
                      onMouseOut={(e) => {
                        if (!isActive) {
                          (e.currentTarget as HTMLElement).style.background = "transparent";
                          (e.currentTarget as HTMLElement).style.color = "rgba(0,0,0,.55)";
                        }
                      }}
                    >
                      {item.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Bottom */}
      <div style={{ padding: "10px 10px 16px", borderTop: "1px solid rgba(0,0,0,.06)" }}>
        {EXTERNAL_LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "6px 12px",
              borderRadius: 8,
              fontSize: 13,
              color: "rgba(0,0,0,.4)",
              textDecoration: "none",
              transition: "all .1s",
            }}
            onMouseOver={(e) => {
              (e.currentTarget as HTMLElement).style.background = "rgba(0,0,0,.04)";
              (e.currentTarget as HTMLElement).style.color = "rgba(0,0,0,.7)";
            }}
            onMouseOut={(e) => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
              (e.currentTarget as HTMLElement).style.color = "rgba(0,0,0,.4)";
            }}
          >
            <span>{link.label}</span>
            <span style={{ fontSize: 11, opacity: 0.5 }}>{link.icon}</span>
          </a>
        ))}
      </div>
    </aside>
  );
}

export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        background: "#faf9f8",
        fontFamily: "var(--font-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
      }}
    >
      <Sidebar />
      <main style={{ flex: 1, marginLeft: 260, minWidth: 0, background: "#fff", borderLeft: "1px solid rgba(0,0,0,.04)" }}>
        {children}
      </main>
    </div>
  );
}
