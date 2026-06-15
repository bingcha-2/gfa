"use client";

import { useEffect, useState } from "react";
import { Apple, Laptop, MonitorDown } from "lucide-react";
import { MarketingShell } from "@/components/marketing/shell";
import { fmt } from "@/lib/i18n";
import { useDict } from "@/lib/i18n/client";

interface Platform { url: string; sha256: string; size: number }
interface VersionInfo {
  version: string; url: string; sha256: string; size: number; changelog: string;
  macOS?: { arm64?: Platform; amd64?: Platform };
  linux?: { amd64?: Platform };
}

const mb = (b?: number) => (b ? Math.round(b / 1024 / 1024) : null);

function LinuxIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12.5 2C11.3 2 10.2 2.6 9.5 3.5C8.9 4.3 8.6 5.3 8.6 6.3C8.6 6.5 8.6 6.7 8.7 6.9C7.2 7.8 6.2 9.4 6 11.2C5.5 11.5 5.1 12 4.8 12.5C4.3 13.4 4 14.5 4 15.5C4 16.8 4.5 18 5.3 18.9C5.5 19.8 6 20.5 6.7 21C7.4 21.5 8.2 21.8 9.1 21.9C9.7 22 10.3 22 11 22H13C13.7 22 14.3 22 14.9 21.9C15.8 21.8 16.6 21.5 17.3 21C18 20.5 18.5 19.8 18.7 18.9C19.5 18 20 16.8 20 15.5C20 14.5 19.7 13.4 19.2 12.5C18.9 12 18.5 11.5 18 11.2C17.8 9.4 16.8 7.8 15.3 6.9C15.4 6.7 15.4 6.5 15.4 6.3C15.4 5.3 15.1 4.3 14.5 3.5C13.8 2.6 12.7 2 12.5 2ZM10.5 8.5C11 8.2 11.5 8.5 11.5 9C11.5 9.3 11.3 9.5 11 9.6C10.7 9.7 10.5 9.5 10.5 9.2C10.3 9 10.3 8.7 10.5 8.5ZM13.5 8.5C13.7 8.7 13.7 9 13.5 9.2C13.5 9.5 13.3 9.7 13 9.6C12.7 9.5 12.5 9.3 12.5 9C12.5 8.5 13 8.2 13.5 8.5Z" fill="var(--codex)" />
    </svg>
  );
}

export default function DownloadPage() {
  const t = useDict();
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
            <span className="mkt-pagehead__eyebrow">{t.download.eyebrow}</span>
            <h1>{t.download.title}</h1>
            <p>{t.download.sub}</p>
          </div>

          <div className="mkt-download-matrix mkt-block">
            <a
              className="mkt-dlcard mkt-download-matrix__recommended"
              href={info?.url || "#"}
              data-detected={os === "windows"}
            >
              <span className="mkt-dlcard__icon"><MonitorDown aria-hidden /></span>
              <div className="mkt-dlcard__main">
                <div className="mkt-dlcard__t">Windows{os === "windows" && <span className="mkt-dlcard__rec">{t.download.recommended}</span>}</div>
                <div className="mkt-dlcard__meta">{fmt(t.download.winMeta, { version, size: winSize })}</div>
              </div>
              <span className="mkt-btn mkt-btn--primary">{t.download.downloadNow}</span>
              <span className="mkt-dlcard__hint">{t.download.winHint}</span>
            </a>

            <div className="mkt-download-matrix__secondary">
              {(macArm || macAmd) && (
                <div className="mkt-dlcard" data-detected={os === "macos"}>
                  <span className="mkt-dlcard__icon"><Apple aria-hidden /></span>
                  <div className="mkt-dlcard__main">
                    <div className="mkt-dlcard__t">macOS{os === "macos" && <span className="mkt-dlcard__rec">{t.download.recommended}</span>}</div>
                    <div className="mkt-dlcard__meta">{fmt(t.download.macMeta, { version })}</div>
                  </div>
                  <div className="mkt-dlbtns">
                    {macArm && (
                      <a className="mkt-btn mkt-btn--primary mkt-btn--sm" href={macArm.url || "#"}>
                        {t.download.appleSilicon}{mb(macArm.size) && `, ${mb(macArm.size)} MB`}
                      </a>
                    )}
                    {macAmd && (
                      <a className="mkt-btn mkt-btn--ghost mkt-btn--sm" href={macAmd.url || "#"}>
                        {t.download.intel}{mb(macAmd.size) && `, ${mb(macAmd.size)} MB`}
                      </a>
                    )}
                  </div>
                  <span className="mkt-dlcard__hint">{t.download.macHint}</span>
                </div>
              )}

              {linux && (
                <a className="mkt-dlcard" href={linux.url || "#"} data-detected={os === "linux"}>
                  <span className="mkt-dlcard__icon"><LinuxIcon /></span>
                  <div className="mkt-dlcard__main">
                    <div className="mkt-dlcard__t">Linux{os === "linux" && <span className="mkt-dlcard__rec">{t.download.recommended}</span>}</div>
                    <div className="mkt-dlcard__meta">{fmt(t.download.linuxMeta, { version })}{mb(linux.size) && `, ${mb(linux.size)} MB`}, tar.gz</div>
                  </div>
                  <span className="mkt-btn mkt-btn--primary">{t.download.downloadTar}</span>
                  <span className="mkt-dlcard__hint">{t.download.linuxHint}</span>
                </a>
              )}

              {!macArm && !macAmd && !linux && (
                <div className="mkt-dlcard">
                  <span className="mkt-dlcard__icon"><Laptop aria-hidden /></span>
                  <div className="mkt-dlcard__main">
                    <div className="mkt-dlcard__t">{t.download.guideTitle}</div>
                    <div className="mkt-dlcard__meta">{version}</div>
                  </div>
                  <span className="mkt-dlcard__hint">{t.download.autoUpdateNote}</span>
                </div>
              )}
            </div>
          </div>

          {info?.changelog && (
            <div className="mkt-support-panel mkt-block">
              <div className="mkt-feature-band__content">
                <h2>{fmt(t.download.changelogTitle, { version: info.version })}</h2>
                <p>{info.changelog}</p>
              </div>
            </div>
          )}

          <div className="mkt-feature-band mkt-feature-band--split">
            <div className="mkt-feature-band__content">
              <h2>{t.download.guideTitle}</h2>
              <p>{t.download.autoUpdateNote}</p>
            </div>
            <div className="mkt-process">
              {t.download.steps.map((s) => (
                <article className="mkt-process__item" key={s}>
                  <div>
                    <h3>{s}</h3>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
