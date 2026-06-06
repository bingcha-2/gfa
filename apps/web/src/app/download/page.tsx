"use client";

import { useEffect, useState } from "react";
import { PublicShell } from "@/components/public-shell";

interface MacOSPlatform {
  url: string;
  sha256: string;
  size: number;
}

interface VersionInfo {
  version: string;
  url: string;
  sha256: string;
  size: number;
  changelog: string;
  macOS?: {
    arm64?: MacOSPlatform;
    amd64?: MacOSPlatform;
  };
  linux?: {
    amd64?: MacOSPlatform;
  };
}

/* ── 样式 ── */
const contentStyle: React.CSSProperties = {
  maxWidth: 960,
  padding: "0 48px",
};

const cardBase: React.CSSProperties = {
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "center",
  gap: 14,
  padding: "28px 24px",
  borderRadius: 14,
  textDecoration: "none",
  transition: "all .2s",
  cursor: "pointer",
};

const cardHover = (e: React.MouseEvent, enter: boolean) => {
  const el = e.currentTarget as HTMLElement;
  el.style.transform = enter ? "translateY(-2px)" : "translateY(0)";
  el.style.boxShadow = enter
    ? "0 8px 24px rgba(0,0,0,.08)"
    : "0 1px 3px rgba(0,0,0,.04)";
};

export default function DownloadPage() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [detectedOS, setDetectedOS] = useState<"windows" | "macos" | "linux" | "other">("windows");

  useEffect(() => {
    fetch("/updates/latest-wails.json?t=" + Date.now())
      .then((r) => r.json())
      .then((data) => setInfo(data))
      .catch(() => {});

    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("mac")) setDetectedOS("macos");
    else if (ua.includes("linux")) setDetectedOS("linux");
    else if (ua.includes("win")) setDetectedOS("windows");
    else setDetectedOS("other");
  }, []);

  const version = info?.version || "latest";

  const winUrl = info?.url || "#";
  const winSizeMB = info?.size ? Math.round(info.size / 1024 / 1024) : 12;

  const macArm64 = info?.macOS?.arm64;
  const macAmd64 = info?.macOS?.amd64;
  const macArm64SizeMB = macArm64?.size ? Math.round(macArm64.size / 1024 / 1024) : null;
  const macAmd64SizeMB = macAmd64?.size ? Math.round(macAmd64.size / 1024 / 1024) : null;

  const linuxAmd64 = info?.linux?.amd64;
  const linuxSizeMB = linuxAmd64?.size ? Math.round(linuxAmd64.size / 1024 / 1024) : null;

  return (
    <PublicShell>
      <div style={{ paddingTop: 48, paddingBottom: 80, width: "100%" }}>

        {/* ── Header ── */}
        <section style={{ ...contentStyle, marginBottom: 40 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 12px 5px 8px",
              borderRadius: 20,
              background: "rgba(99,102,241,.06)",
              border: "1px solid rgba(99,102,241,.1)",
              fontSize: 12,
              fontWeight: 600,
              color: "#6366f1",
              marginBottom: 20,
            }}
          >
            <span style={{ fontSize: 14 }}>⬇</span>
            下载中心
          </div>

          <h1
            style={{
              fontSize: "clamp(26px, 3.5vw, 34px)",
              fontWeight: 800,
              color: "#111",
              letterSpacing: "-0.03em",
              lineHeight: 1.2,
              margin: "0 0 12px",
            }}
          >
            下载冰茶AI 客户端
          </h1>
          <p style={{ fontSize: 15, color: "rgba(0,0,0,.45)", margin: 0, lineHeight: 1.6, maxWidth: 480 }}>
            一键续杯，无需 IDE 插件。下载后直接运行，输入卡密即可使用。
          </p>
        </section>

        <div style={{ ...contentStyle, marginBottom: 0 }}>
          <div style={{ height: 1, background: "rgba(0,0,0,.06)", marginBottom: 40 }} />
        </div>

        {/* ── 下载卡片区 ── */}
        <section
          style={{
            ...contentStyle,
            display: "flex",
            flexDirection: "column",
            gap: 16,
            marginBottom: 40,
          }}
        >
          {/* Windows */}
          <a
            href={winUrl}
            style={{
              ...cardBase,
              border: detectedOS === "windows"
                ? "2px solid rgba(99,102,241,.35)"
                : "1px solid rgba(99,102,241,.15)",
              background: detectedOS === "windows"
                ? "rgba(99,102,241,.04)"
                : "#fff",
              boxShadow: "0 1px 3px rgba(0,0,0,.04)",
              order: detectedOS === "windows" ? 0 : 1,
            }}
            onMouseOver={(e) => cardHover(e, true)}
            onMouseOut={(e) => cardHover(e, false)}
          >
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M3 5.548l7.065-0.96v6.825H3V5.548zm0 12.9l7.065 0.967V12.58H3v5.868zm7.834 1.073L21 20.998V12.58H10.834v6.941zm0-14.046v7.092H21V3L10.834 5.475z" fill="#6366f1"/>
            </svg>
            <div style={{ textAlign: "center" }}>
              <div style={{ color: "#111", fontWeight: 700, fontSize: 17, marginBottom: 4 }}>
                Windows 版下载
              </div>
              <div style={{ color: "rgba(0,0,0,.4)", fontSize: 12 }}>
                Windows 10 / 11 (64-bit) · v{version} · {winSizeMB} MB
              </div>
            </div>
            <div
              style={{
                padding: "9px 28px",
                borderRadius: 8,
                background: "#6366f1",
                color: "#fff",
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              ⬇ 立即下载
            </div>
            <div style={{ color: "rgba(0,0,0,.3)", fontSize: 11 }}>
              免安装，下载后直接双击运行
            </div>
          </a>

          {/* macOS */}
          {(macArm64 || macAmd64) && (
            <div
              style={{
                ...cardBase,
                cursor: "default",
                border: detectedOS === "macos"
                  ? "2px solid rgba(0,0,0,.15)"
                  : "1px solid rgba(0,0,0,.08)",
                background: detectedOS === "macos"
                  ? "rgba(0,0,0,.02)"
                  : "#fff",
                boxShadow: "0 1px 3px rgba(0,0,0,.04)",
                order: detectedOS === "macos" ? 0 : 1,
              }}
            >
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M18.71 19.5C17.88 20.74 17 21.95 15.66 21.97C14.32 22 13.89 21.18 12.37 21.18C10.84 21.18 10.37 21.95 9.1 22C7.79 22.05 6.8 20.68 5.96 19.47C4.25 16.56 2.93 11.3 4.7 7.72C5.57 5.94 7.36 4.86 9.3 4.83C10.57 4.81 11.78 5.7 12.56 5.7C13.34 5.7 14.82 4.62 16.38 4.79C17.06 4.82 18.89 5.08 20.05 6.8C19.93 6.88 17.62 8.23 17.65 11.06C17.68 14.42 20.53 15.46 20.57 15.47C20.54 15.56 20.12 17 19.03 18.49L18.71 19.5ZM13 3.5C13.73 2.67 14.94 2.04 15.94 2C16.07 3.17 15.6 4.35 14.9 5.19C14.21 6.04 13.07 6.7 11.95 6.61C11.8 5.46 12.36 4.26 13 3.5Z" fill="#78716c"/>
              </svg>
              <div style={{ textAlign: "center" }}>
                <div style={{ color: "#111", fontWeight: 700, fontSize: 17, marginBottom: 4 }}>
                  macOS 版下载
                </div>
                <div style={{ color: "rgba(0,0,0,.4)", fontSize: 12 }}>
                  macOS 12+ · v{version}
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
                {macArm64 && (
                  <a
                    href={macArm64?.url || "#"}
                    style={{
                      padding: "9px 20px",
                      borderRadius: 8,
                      background: "#111",
                      color: "#fff",
                      fontWeight: 600,
                      fontSize: 13,
                      textDecoration: "none",
                      transition: "opacity .15s",
                    }}
                    onMouseOver={(e) => { (e.currentTarget as HTMLElement).style.opacity = "0.85"; }}
                    onMouseOut={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
                  >
                    ⬇ Apple Silicon (M1/M2/M3)
                    {macArm64SizeMB && <span style={{ opacity: 0.5, fontSize: 11, marginLeft: 6 }}>{macArm64SizeMB} MB</span>}
                  </a>
                )}
                {macAmd64 && (
                  <a
                    href={macAmd64?.url || "#"}
                    style={{
                      padding: "9px 20px",
                      borderRadius: 8,
                      background: "rgba(0,0,0,.06)",
                      border: "1px solid rgba(0,0,0,.1)",
                      color: "#333",
                      fontWeight: 600,
                      fontSize: 13,
                      textDecoration: "none",
                      transition: "all .15s",
                    }}
                    onMouseOver={(e) => {
                      (e.currentTarget as HTMLElement).style.background = "rgba(0,0,0,.1)";
                    }}
                    onMouseOut={(e) => {
                      (e.currentTarget as HTMLElement).style.background = "rgba(0,0,0,.06)";
                    }}
                  >
                    ⬇ Intel
                    {macAmd64SizeMB && <span style={{ opacity: 0.5, fontSize: 11, marginLeft: 6 }}>{macAmd64SizeMB} MB</span>}
                  </a>
                )}
              </div>
              <div style={{ color: "rgba(0,0,0,.3)", fontSize: 11 }}>
                首次打开：右键应用 → 打开 → 确认打开
              </div>
            </div>
          )}

          {/* Linux */}
          {linuxAmd64 && (
            <a
              href={linuxAmd64?.url || "#"}
              style={{
                ...cardBase,
                border: detectedOS === "linux"
                  ? "2px solid rgba(202,138,4,.3)"
                  : "1px solid rgba(202,138,4,.15)",
                background: detectedOS === "linux"
                  ? "rgba(202,138,4,.04)"
                  : "#fff",
                boxShadow: "0 1px 3px rgba(0,0,0,.04)",
                order: detectedOS === "linux" ? 0 : 2,
              }}
              onMouseOver={(e) => cardHover(e, true)}
              onMouseOut={(e) => cardHover(e, false)}
            >
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12.5 2C11.3 2 10.2 2.6 9.5 3.5C8.9 4.3 8.6 5.3 8.6 6.3C8.6 6.5 8.6 6.7 8.7 6.9C7.2 7.8 6.2 9.4 6 11.2C5.5 11.5 5.1 12 4.8 12.5C4.3 13.4 4 14.5 4 15.5C4 16.8 4.5 18 5.3 18.9C5.5 19.8 6 20.5 6.7 21C7.4 21.5 8.2 21.8 9.1 21.9C9.7 22 10.3 22 11 22H13C13.7 22 14.3 22 14.9 21.9C15.8 21.8 16.6 21.5 17.3 21C18 20.5 18.5 19.8 18.7 18.9C19.5 18 20 16.8 20 15.5C20 14.5 19.7 13.4 19.2 12.5C18.9 12 18.5 11.5 18 11.2C17.8 9.4 16.8 7.8 15.3 6.9C15.4 6.7 15.4 6.5 15.4 6.3C15.4 5.3 15.1 4.3 14.5 3.5C13.8 2.6 12.7 2 12.5 2ZM10.5 8.5C11 8.2 11.5 8.5 11.5 9C11.5 9.3 11.3 9.5 11 9.6C10.7 9.7 10.5 9.5 10.5 9.2C10.3 9 10.3 8.7 10.5 8.5ZM13.5 8.5C13.7 8.7 13.7 9 13.5 9.2C13.5 9.5 13.3 9.7 13 9.6C12.7 9.5 12.5 9.3 12.5 9C12.5 8.5 13 8.2 13.5 8.5Z" fill="#ca8a04"/>
              </svg>
              <div style={{ textAlign: "center" }}>
                <div style={{ color: "#111", fontWeight: 700, fontSize: 17, marginBottom: 4 }}>
                  Linux 版下载
                </div>
                <div style={{ color: "rgba(0,0,0,.4)", fontSize: 12 }}>
                  x86_64 · v{version}{linuxSizeMB && ` · ${linuxSizeMB} MB`} · tar.gz
                </div>
              </div>
              <div
                style={{
                  padding: "9px 28px",
                  borderRadius: 8,
                  background: "#ca8a04",
                  color: "#fff",
                  fontWeight: 600,
                  fontSize: 14,
                }}
              >
                ⬇ 下载 tar.gz
              </div>
              <div style={{ color: "rgba(0,0,0,.3)", fontSize: 11 }}>
                解压后 chmod +x 运行
              </div>
            </a>
          )}
        </section>

        {/* ── Changelog ── */}
        {info?.changelog && (
          <section style={{ ...contentStyle, marginBottom: 20 }}>
            <div
              style={{
                padding: "12px 16px",
                borderRadius: 10,
                background: "rgba(99,102,241,.04)",
                border: "1px solid rgba(99,102,241,.1)",
                fontSize: 13,
                color: "rgba(0,0,0,.55)",
              }}
            >
              <span style={{ fontWeight: 600, color: "#6366f1" }}>v{info.version} 更新：</span> {info.changelog}
            </div>
          </section>
        )}

        {/* ── 使用说明 ── */}
        <section style={{ ...contentStyle, marginBottom: 24 }}>
          <div
            style={{
              padding: "20px 24px",
              borderRadius: 12,
              background: "rgba(0,0,0,.015)",
              border: "1px solid rgba(0,0,0,.06)",
            }}
          >
            <h3 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 700, color: "#111" }}>
              使用说明
            </h3>
            <div style={{ display: "grid", gap: 10, fontSize: 13, color: "rgba(0,0,0,.5)", lineHeight: 1.65 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span style={{ color: "#ea580c", fontWeight: 700, flexShrink: 0 }}>1.</span>
                <span>下载 BingchaAI 后直接运行（Windows 免安装，macOS 拖入应用程序文件夹）</span>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span style={{ color: "#ea580c", fontWeight: 700, flexShrink: 0 }}>2.</span>
                <span>输入您的续杯卡密，或切换到本地号池模式添加自有账号</span>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span style={{ color: "#ea580c", fontWeight: 700, flexShrink: 0 }}>3.</span>
                <span>点击「开启接管」，在 Cursor / Windsurf 等 IDE 中正常使用即可</span>
              </div>
            </div>
            <div
              style={{
                marginTop: 14,
                padding: "10px 14px",
                borderRadius: 8,
                background: "rgba(34,197,94,.04)",
                border: "1px solid rgba(34,197,94,.12)",
                fontSize: 12,
                color: "#16a34a",
              }}
            >
              ✅ 客户端支持自动更新，首次下载后无需手动升级。
            </div>
          </div>
        </section>

      </div>
    </PublicShell>
  );
}
