"use client";

import { useEffect, useState } from "react";

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
  installerUrl?: string;
  installerSize?: number;
  changelog: string;
  macOS?: {
    arm64?: MacOSPlatform;
    amd64?: MacOSPlatform;
  };
  linux?: {
    amd64?: MacOSPlatform;
  };
}

export default function DownloadPage() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [detectedOS, setDetectedOS] = useState<"windows" | "macos" | "linux" | "other">("windows");

  useEffect(() => {
    fetch("/updates/latest-wails.json?t=" + Date.now())
      .then((r) => r.json())
      .then((data) => setInfo(data))
      .catch(() => {});

    // 检测用户操作系统
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("mac")) setDetectedOS("macos");
    else if (ua.includes("linux")) setDetectedOS("linux");
    else if (ua.includes("win")) setDetectedOS("windows");
    else setDetectedOS("other");
  }, []);

  const version = info?.version || "latest";

  // Windows 下载（优先 NSIS 安装包 installerUrl，旧 manifest 无此字段时回退到裸 exe url）
  const winUrl = info?.installerUrl || info?.url || "#";
  const winDownloadSize = info?.installerUrl ? info?.installerSize : info?.size;
  const winSizeMB = winDownloadSize ? Math.round(winDownloadSize / 1024 / 1024) : 12;

  // macOS 下载
  const macArm64 = info?.macOS?.arm64;
  const macAmd64 = info?.macOS?.amd64;
  const macArm64SizeMB = macArm64?.size ? Math.round(macArm64.size / 1024 / 1024) : null;
  const macAmd64SizeMB = macAmd64?.size ? Math.round(macAmd64.size / 1024 / 1024) : null;

  // Linux 下载
  const linuxAmd64 = info?.linux?.amd64;
  const linuxSizeMB = linuxAmd64?.size ? Math.round(linuxAmd64.size / 1024 / 1024) : null;

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

        {/* ── Windows Download Card ── */}
        <a
          href={winUrl}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 16,
            padding: "32px 24px",
            borderRadius: 16,
            border: detectedOS === "windows"
              ? "1px solid rgba(99,102,241,.5)"
              : "1px solid rgba(99,102,241,.2)",
            background: detectedOS === "windows"
              ? "rgba(99,102,241,.12)"
              : "rgba(99,102,241,.05)",
            textDecoration: "none",
            transition: "all .2s",
            cursor: "pointer",
            order: detectedOS === "windows" ? 0 : 1,
          }}
          onMouseOver={(e) => {
            (e.currentTarget as HTMLElement).style.background = "rgba(99,102,241,.15)";
            (e.currentTarget as HTMLElement).style.borderColor = "rgba(99,102,241,.5)";
            (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)";
          }}
          onMouseOut={(e) => {
            (e.currentTarget as HTMLElement).style.background = detectedOS === "windows" ? "rgba(99,102,241,.12)" : "rgba(99,102,241,.05)";
            (e.currentTarget as HTMLElement).style.borderColor = detectedOS === "windows" ? "rgba(99,102,241,.5)" : "rgba(99,102,241,.2)";
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
              Windows 10 / 11 (64-bit) · v{version} · {winSizeMB} MB
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

        {/* ── macOS Download Card ── */}
        {(macArm64 || macAmd64) && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
              padding: "28px 24px",
              borderRadius: 16,
              border: detectedOS === "macos"
                ? "1px solid rgba(168,162,158,.4)"
                : "1px solid rgba(168,162,158,.15)",
              background: detectedOS === "macos"
                ? "rgba(168,162,158,.08)"
                : "rgba(168,162,158,.03)",
              order: detectedOS === "macos" ? 0 : 1,
            }}
          >
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M18.71 19.5C17.88 20.74 17 21.95 15.66 21.97C14.32 22 13.89 21.18 12.37 21.18C10.84 21.18 10.37 21.95 9.1 22C7.79 22.05 6.8 20.68 5.96 19.47C4.25 16.56 2.93 11.3 4.7 7.72C5.57 5.94 7.36 4.86 9.3 4.83C10.57 4.81 11.78 5.7 12.56 5.7C13.34 5.7 14.82 4.62 16.38 4.79C17.06 4.82 18.89 5.08 20.05 6.8C19.93 6.88 17.62 8.23 17.65 11.06C17.68 14.42 20.53 15.46 20.57 15.47C20.54 15.56 20.12 17 19.03 18.49L18.71 19.5ZM13 3.5C13.73 2.67 14.94 2.04 15.94 2C16.07 3.17 15.6 4.35 14.9 5.19C14.21 6.04 13.07 6.7 11.95 6.61C11.8 5.46 12.36 4.26 13 3.5Z" fill="#a8a29e"/>
            </svg>
            <div style={{ textAlign: "center" }}>
              <div style={{ color: "#d6d3d1", fontWeight: 700, fontSize: 18, marginBottom: 4 }}>
                macOS 版下载
              </div>
              <div style={{ color: "rgba(255,255,255,.4)", fontSize: 12 }}>
                macOS 12+ · v{version}
              </div>
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
              {macArm64 && (
                <a
                  href={macArm64?.url || "#"}
                  style={{
                    padding: "10px 24px",
                    borderRadius: 8,
                    background: "rgba(168,162,158,.12)",
                    border: "1px solid rgba(168,162,158,.25)",
                    color: "#d6d3d1",
                    fontWeight: 600,
                    fontSize: 14,
                    textDecoration: "none",
                    transition: "all .2s",
                  }}
                  onMouseOver={(e) => {
                    (e.currentTarget as HTMLElement).style.background = "rgba(168,162,158,.2)";
                  }}
                  onMouseOut={(e) => {
                    (e.currentTarget as HTMLElement).style.background = "rgba(168,162,158,.12)";
                  }}
                >
                  ⬇ Apple Silicon (M1/M2/M3)
                  {macArm64SizeMB && <span style={{ color: "rgba(255,255,255,.35)", fontSize: 11, marginLeft: 6 }}>{macArm64SizeMB} MB</span>}
                </a>
              )}
              {macAmd64 && (
                <a
                  href={macAmd64?.url || "#"}
                  style={{
                    padding: "10px 24px",
                    borderRadius: 8,
                    background: "rgba(168,162,158,.08)",
                    border: "1px solid rgba(168,162,158,.15)",
                    color: "#a8a29e",
                    fontWeight: 600,
                    fontSize: 14,
                    textDecoration: "none",
                    transition: "all .2s",
                  }}
                  onMouseOver={(e) => {
                    (e.currentTarget as HTMLElement).style.background = "rgba(168,162,158,.15)";
                  }}
                  onMouseOut={(e) => {
                    (e.currentTarget as HTMLElement).style.background = "rgba(168,162,158,.08)";
                  }}
                >
                  ⬇ Intel
                  {macAmd64SizeMB && <span style={{ color: "rgba(255,255,255,.3)", fontSize: 11, marginLeft: 6 }}>{macAmd64SizeMB} MB</span>}
                </a>
              )}
            </div>
            <div style={{ color: "rgba(255,255,255,.25)", fontSize: 11 }}>
              首次打开：右键应用 → 打开 → 确认打开
            </div>
          </div>
        )}

        {/* ── Linux Download Card ── */}
        {linuxAmd64 && (
          <a
            href={linuxAmd64?.url || "#"}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
              padding: "28px 24px",
              borderRadius: 16,
              border: detectedOS === "linux"
                ? "1px solid rgba(250,204,21,.4)"
                : "1px solid rgba(250,204,21,.15)",
              background: detectedOS === "linux"
                ? "rgba(250,204,21,.08)"
                : "rgba(250,204,21,.03)",
              textDecoration: "none",
              transition: "all .2s",
              cursor: "pointer",
              order: detectedOS === "linux" ? 0 : 2,
            }}
            onMouseOver={(e) => {
              (e.currentTarget as HTMLElement).style.background = "rgba(250,204,21,.12)";
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(250,204,21,.4)";
              (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)";
            }}
            onMouseOut={(e) => {
              (e.currentTarget as HTMLElement).style.background = detectedOS === "linux" ? "rgba(250,204,21,.08)" : "rgba(250,204,21,.03)";
              (e.currentTarget as HTMLElement).style.borderColor = detectedOS === "linux" ? "rgba(250,204,21,.4)" : "rgba(250,204,21,.15)";
              (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
            }}
          >
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12.5 2C11.3 2 10.2 2.6 9.5 3.5C8.9 4.3 8.6 5.3 8.6 6.3C8.6 6.5 8.6 6.7 8.7 6.9C7.2 7.8 6.2 9.4 6 11.2C5.5 11.5 5.1 12 4.8 12.5C4.3 13.4 4 14.5 4 15.5C4 16.8 4.5 18 5.3 18.9C5.5 19.8 6 20.5 6.7 21C7.4 21.5 8.2 21.8 9.1 21.9C9.7 22 10.3 22 11 22H13C13.7 22 14.3 22 14.9 21.9C15.8 21.8 16.6 21.5 17.3 21C18 20.5 18.5 19.8 18.7 18.9C19.5 18 20 16.8 20 15.5C20 14.5 19.7 13.4 19.2 12.5C18.9 12 18.5 11.5 18 11.2C17.8 9.4 16.8 7.8 15.3 6.9C15.4 6.7 15.4 6.5 15.4 6.3C15.4 5.3 15.1 4.3 14.5 3.5C13.8 2.6 12.7 2 12.5 2ZM10.5 8.5C11 8.2 11.5 8.5 11.5 9C11.5 9.3 11.3 9.5 11 9.6C10.7 9.7 10.5 9.5 10.5 9.2C10.3 9 10.3 8.7 10.5 8.5ZM13.5 8.5C13.7 8.7 13.7 9 13.5 9.2C13.5 9.5 13.3 9.7 13 9.6C12.7 9.5 12.5 9.3 12.5 9C12.5 8.5 13 8.2 13.5 8.5Z" fill="#facc15"/>
            </svg>
            <div style={{ textAlign: "center" }}>
              <div style={{ color: "#fde68a", fontWeight: 700, fontSize: 18, marginBottom: 4 }}>
                Linux 版下载
              </div>
              <div style={{ color: "rgba(255,255,255,.4)", fontSize: 12 }}>
                x86_64 · v{version}{linuxSizeMB && ` · ${linuxSizeMB} MB`} · tar.gz
              </div>
            </div>
            <div
              style={{
                padding: "10px 32px",
                borderRadius: 8,
                background: "rgba(250,204,21,.12)",
                border: "1px solid rgba(250,204,21,.25)",
                color: "#fde68a",
                fontWeight: 600,
                fontSize: 15,
              }}
            >
              ⬇ 下载 tar.gz
            </div>
            <div style={{ color: "rgba(255,255,255,.25)", fontSize: 11 }}>
              解压后 chmod +x 运行
            </div>
          </a>
        )}

        {/* Changelog */}
        {info?.changelog && (
          <div
            style={{
              order: 2,
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
            order: 3,
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
              <span>下载 BingchaAI 后直接运行（Windows 免安装，macOS 拖入应用程序文件夹）</span>
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
            ✅ 客户端支持自动更新，首次下载后无需手动升级。
          </div>
        </div>

        {/* Footer link */}
        <div style={{ textAlign: "center", order: 4 }}>
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
