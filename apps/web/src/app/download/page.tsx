"use client";

import { useEffect, useState } from "react";

interface VersionInfo {
  version: string;
  url: string;
  size: number;
  changelog: string;
}

export default function DownloadPage() {
  const [info, setInfo] = useState<VersionInfo | null>(null);

  useEffect(() => {
    fetch("/updates/latest-wails.json")
      .then((r) => r.json())
      .then((data) => setInfo(data))
      .catch(() => {});
  }, []);

  const version = info?.version || "latest";
  const sizeMB = info?.size ? Math.round(info.size / 1024 / 1024) : 12;
  const downloadUrl = info?.url
    ? `/updates/BingchaAI-${info.version}.exe`
    : "/updates/BingchaAI-latest.exe";

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 20px",
        background: "linear-gradient(145deg, #0c0a15 0%, #1a1333 40%, #0f172a 100%)",
        fontFamily: "var(--font-sans), system-ui, sans-serif",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 640,
          display: "flex",
          flexDirection: "column",
          gap: 32,
        }}
      >
        {/* Header */}
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 64,
              height: 64,
              borderRadius: 16,
              background: "linear-gradient(135deg, #ea580c, #f97316)",
              marginBottom: 20,
              fontSize: 32,
            }}
          >
            🍵
          </div>
          <h1
            style={{
              fontSize: 32,
              fontWeight: 800,
              background: "linear-gradient(90deg, #f97316, #fb923c, #fbbf24)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              margin: "0 0 8px",
              letterSpacing: "-0.02em",
            }}
          >
            冰茶AI 客户端
          </h1>
          <p
            style={{
              color: "rgba(255,255,255,.55)",
              fontSize: 15,
              margin: 0,
              lineHeight: 1.6,
            }}
          >
            一键续杯，无需 IDE 插件。下载后直接运行，输入卡密即可使用。
          </p>
        </div>

        {/* Download Card — Windows only */}
        <a
          href={downloadUrl}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 16,
            padding: "32px 24px",
            borderRadius: 16,
            border: "1px solid rgba(99,102,241,.3)",
            background: "rgba(99,102,241,.08)",
            textDecoration: "none",
            transition: "all .2s",
            cursor: "pointer",
          }}
          onMouseOver={(e) => {
            (e.currentTarget as HTMLElement).style.background = "rgba(99,102,241,.15)";
            (e.currentTarget as HTMLElement).style.borderColor = "rgba(99,102,241,.5)";
            (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)";
          }}
          onMouseOut={(e) => {
            (e.currentTarget as HTMLElement).style.background = "rgba(99,102,241,.08)";
            (e.currentTarget as HTMLElement).style.borderColor = "rgba(99,102,241,.3)";
            (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
          }}
        >
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M3 5.548l7.065-0.96v6.825H3V5.548zm0 12.9l7.065 0.967V12.58H3v5.868zm7.834 1.073L21 20.998V12.58H10.834v6.941zm0-14.046v7.092H21V3L10.834 5.475z" fill="#818cf8"/>
          </svg>
          <div style={{ textAlign: "center" }}>
            <div style={{ color: "#c7d2fe", fontWeight: 700, fontSize: 18, marginBottom: 4 }}>
              Windows 版下载
            </div>
            <div style={{ color: "rgba(255,255,255,.4)", fontSize: 12 }}>
              Windows 10 / 11 (64-bit) · v{version} · {sizeMB} MB
            </div>
          </div>
          <div
            style={{
              padding: "10px 32px",
              borderRadius: 8,
              background: "linear-gradient(135deg, #6366f1, #4f46e5)",
              color: "#fff",
              fontWeight: 600,
              fontSize: 15,
            }}
          >
            ⬇ 立即下载
          </div>
          <div style={{ color: "rgba(255,255,255,.3)", fontSize: 11 }}>
            免安装，下载后直接双击运行
          </div>
        </a>

        {/* Changelog */}
        {info?.changelog && (
          <div
            style={{
              padding: "12px 16px",
              borderRadius: 10,
              background: "rgba(99,102,241,.06)",
              border: "1px solid rgba(99,102,241,.15)",
              fontSize: 12,
              color: "rgba(165,180,252,.7)",
            }}
          >
            <span style={{ fontWeight: 600 }}>v{info.version} 更新：</span> {info.changelog}
          </div>
        )}

        {/* Info */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: "20px 24px",
            borderRadius: 12,
            background: "rgba(255,255,255,.03)",
            border: "1px solid rgba(255,255,255,.08)",
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: 14,
              fontWeight: 700,
              color: "rgba(255,255,255,.7)",
            }}
          >
            使用说明
          </h3>
          <div style={{ display: "grid", gap: 8, fontSize: 13, color: "rgba(255,255,255,.45)", lineHeight: 1.6 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span style={{ color: "#f97316", fontWeight: 700, flexShrink: 0 }}>1.</span>
              <span>下载 BingchaAI.exe 后直接双击运行，无需安装</span>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span style={{ color: "#f97316", fontWeight: 700, flexShrink: 0 }}>2.</span>
              <span>输入您的续杯卡密，或切换到本地号池模式添加自有账号</span>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span style={{ color: "#f97316", fontWeight: 700, flexShrink: 0 }}>3.</span>
              <span>点击「开启接管」，在 Cursor / Windsurf 等 IDE 中正常使用即可</span>
            </div>
          </div>
          <div
            style={{
              marginTop: 4,
              padding: "10px 14px",
              borderRadius: 8,
              background: "rgba(34,197,94,.06)",
              border: "1px solid rgba(34,197,94,.15)",
              fontSize: 12,
              color: "rgba(34,197,94,.7)",
            }}
          >
            ✅ 客户端支持自动更新，首次下载后无需手动升级。体积仅 {sizeMB} MB，启动秒开。
          </div>
        </div>

        {/* Footer link */}
        <div style={{ textAlign: "center" }}>
          <a
            href="/"
            style={{
              color: "rgba(255,255,255,.35)",
              fontSize: 13,
              textDecoration: "none",
            }}
          >
            ← 返回首页
          </a>
        </div>
      </div>
    </main>
  );
}
