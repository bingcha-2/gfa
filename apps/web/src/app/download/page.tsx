"use client";

import { useEffect, useState } from "react";
import { MarketingShell } from "../_marketing/shell";

interface Platform { url: string; sha256: string; size: number }
interface VersionInfo {
  version: string; url: string; sha256: string; size: number; changelog: string;
  macOS?: { arm64?: Platform; amd64?: Platform };
  linux?: { amd64?: Platform };
}

const mb = (b?: number) => (b ? Math.round(b / 1024 / 1024) : null);

const WinIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden><path d="M3 5.548l7.065-0.96v6.825H3V5.548zm0 12.9l7.065 0.967V12.58H3v5.868zm7.834 1.073L21 20.998V12.58H10.834v6.941zm0-14.046v7.092H21V3L10.834 5.475z" fill="var(--anti)" /></svg>
);
const AppleIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden><path d="M18.71 19.5C17.88 20.74 17 21.95 15.66 21.97C14.32 22 13.89 21.18 12.37 21.18C10.84 21.18 10.37 21.95 9.1 22C7.79 22.05 6.8 20.68 5.96 19.47C4.25 16.56 2.93 11.3 4.7 7.72C5.57 5.94 7.36 4.86 9.3 4.83C10.57 4.81 11.78 5.7 12.56 5.7C13.34 5.7 14.82 4.62 16.38 4.79C17.06 4.82 18.89 5.08 20.05 6.8C19.93 6.88 17.62 8.23 17.65 11.06C17.68 14.42 20.53 15.46 20.57 15.47C20.54 15.56 20.12 17 19.03 18.49L18.71 19.5ZM13 3.5C13.73 2.67 14.94 2.04 15.94 2C16.07 3.17 15.6 4.35 14.9 5.19C14.21 6.04 13.07 6.7 11.95 6.61C11.8 5.46 12.36 4.26 13 3.5Z" fill="var(--ink)" /></svg>
);
const LinuxIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden><path d="M12.5 2C11.3 2 10.2 2.6 9.5 3.5C8.9 4.3 8.6 5.3 8.6 6.3C8.6 6.5 8.6 6.7 8.7 6.9C7.2 7.8 6.2 9.4 6 11.2C5.5 11.5 5.1 12 4.8 12.5C4.3 13.4 4 14.5 4 15.5C4 16.8 4.5 18 5.3 18.9C5.5 19.8 6 20.5 6.7 21C7.4 21.5 8.2 21.8 9.1 21.9C9.7 22 10.3 22 11 22H13C13.7 22 14.3 22 14.9 21.9C15.8 21.8 16.6 21.5 17.3 21C18 20.5 18.5 19.8 18.7 18.9C19.5 18 20 16.8 20 15.5C20 14.5 19.7 13.4 19.2 12.5C18.9 12 18.5 11.5 18 11.2C17.8 9.4 16.8 7.8 15.3 6.9C15.4 6.7 15.4 6.5 15.4 6.3C15.4 5.3 15.1 4.3 14.5 3.5C13.8 2.6 12.7 2 12.5 2ZM10.5 8.5C11 8.2 11.5 8.5 11.5 9C11.5 9.3 11.3 9.5 11 9.6C10.7 9.7 10.5 9.5 10.5 9.2C10.3 9 10.3 8.7 10.5 8.5ZM13.5 8.5C13.7 8.7 13.7 9 13.5 9.2C13.5 9.5 13.3 9.7 13 9.6C12.7 9.5 12.5 9.3 12.5 9C12.5 8.5 13 8.2 13.5 8.5Z" fill="var(--codex)" /></svg>
);

const STEPS = [
  "下载 BingchaAI 后直接运行（Windows 免安装，macOS 拖入应用程序文件夹）。",
  "输入你的续杯卡密，或切换到本地号池模式添加自有账号。",
  "点击「开启接管」，在 Antigravity / Claude Code / Codex 等工具中照常使用。",
];

export default function DownloadPage() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [os, setOs] = useState<"windows" | "macos" | "linux" | "other">("windows");

  useEffect(() => {
    fetch("/updates/latest-wails.json?t=" + Date.now()).then((r) => r.json()).then(setInfo).catch(() => {});
    const ua = navigator.userAgent.toLowerCase();
    setOs(ua.includes("mac") ? "macos" : ua.includes("linux") ? "linux" : ua.includes("win") ? "windows" : "other");
  }, []);

  const version = info?.version || "latest";
  const winSize = mb(info?.size) ?? 12;
  const macArm = info?.macOS?.arm64;
  const macAmd = info?.macOS?.amd64;
  const linux = info?.linux?.amd64;

  return (
    <MarketingShell anim={false}>
      <section className="mkt-section mkt-section--tight">
        <div className="mkt-wrap">
          <div className="mkt-pagehead">
            <span className="mkt-pagehead__eyebrow">/ 下载中心</span>
            <h1>下载冰茶AI 客户端</h1>
            <p>一键续杯，无需 IDE 插件。下载后直接运行，输入卡密即可使用。</p>
          </div>

          <div className="mkt-dl" style={{ marginBottom: "2rem" }}>
            {/* Windows */}
            <a className="mkt-dlcard" href={info?.url || "#"} data-detected={os === "windows"} style={{ order: os === "windows" ? 0 : 1 }}>
              <span className="mkt-dlcard__icon"><WinIcon /></span>
              <div className="mkt-dlcard__main">
                <div className="mkt-dlcard__t">Windows{os === "windows" && <span className="mkt-dlcard__rec">推荐</span>}</div>
                <div className="mkt-dlcard__meta">Windows 10 / 11 (64-bit) · v{version} · {winSize} MB</div>
              </div>
              <span className="mkt-btn mkt-btn--primary">立即下载</span>
              <span className="mkt-dlcard__hint">免安装，下载后直接双击运行。</span>
            </a>

            {/* macOS */}
            {(macArm || macAmd) && (
              <div className="mkt-dlcard" data-detected={os === "macos"} style={{ order: os === "macos" ? 0 : 1 }}>
                <span className="mkt-dlcard__icon"><AppleIcon /></span>
                <div className="mkt-dlcard__main">
                  <div className="mkt-dlcard__t">macOS{os === "macos" && <span className="mkt-dlcard__rec">推荐</span>}</div>
                  <div className="mkt-dlcard__meta">macOS 12+ · v{version}</div>
                </div>
                <div className="mkt-dlbtns">
                  {macArm && (
                    <a className="mkt-btn mkt-btn--primary mkt-btn--sm" href={macArm.url || "#"}>
                      Apple Silicon{mb(macArm.size) && ` · ${mb(macArm.size)} MB`}
                    </a>
                  )}
                  {macAmd && (
                    <a className="mkt-btn mkt-btn--ghost mkt-btn--sm" href={macAmd.url || "#"}>
                      Intel{mb(macAmd.size) && ` · ${mb(macAmd.size)} MB`}
                    </a>
                  )}
                </div>
                <span className="mkt-dlcard__hint">首次打开：右键应用 → 打开 → 确认打开。</span>
              </div>
            )}

            {/* Linux */}
            {linux && (
              <a className="mkt-dlcard" href={linux.url || "#"} data-detected={os === "linux"} style={{ order: os === "linux" ? 0 : 2 }}>
                <span className="mkt-dlcard__icon"><LinuxIcon /></span>
                <div className="mkt-dlcard__main">
                  <div className="mkt-dlcard__t">Linux{os === "linux" && <span className="mkt-dlcard__rec">推荐</span>}</div>
                  <div className="mkt-dlcard__meta">x86_64 · v{version}{mb(linux.size) && ` · ${mb(linux.size)} MB`} · tar.gz</div>
                </div>
                <span className="mkt-btn mkt-btn--primary">下载 tar.gz</span>
                <span className="mkt-dlcard__hint">解压后 chmod +x 运行。</span>
              </a>
            )}
          </div>

          {info?.changelog && (
            <div className="mkt-note" style={{ maxWidth: 760 }}>
              <div className="mkt-note__h">v{info.version} 更新</div>
              <p>{info.changelog}</p>
            </div>
          )}

          <div className="mkt-block" style={{ maxWidth: 760, marginTop: "2.5rem", marginBottom: 0 }}>
            <h2>使用说明</h2>
            <div className="mkt-steps" style={{ gridTemplateColumns: "1fr" }}>
              {STEPS.map((s, i) => (
                <div className="mkt-step" key={i} style={{ gridTemplateColumns: "auto 1fr", display: "grid", gap: "0.9rem", alignItems: "start" }}>
                  <span className="mkt-step__n">{i + 1}</span>
                  <p className="mkt-step__d" style={{ alignSelf: "center" }}>{s}</p>
                </div>
              ))}
            </div>
            <div className="mkt-note" style={{ background: "color-mix(in oklch, var(--ok) 12%, transparent)", borderColor: "color-mix(in oklch, var(--ok) 30%, transparent)", marginTop: "1.25rem" }}>
              <p style={{ color: "var(--ink)" }}>客户端支持自动更新，首次下载后无需手动升级。</p>
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
