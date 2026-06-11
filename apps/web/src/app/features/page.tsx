import type { Metadata } from "next";
import { MarketingShell } from "../_marketing/shell";
import { getDict } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getDict();
  return { title: t.meta.featuresTitle, description: t.meta.featuresDescription };
}

const ic = (d: string, sw = "2") => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d.split("|").map((p, i) => <path key={i} d={p} />)}
  </svg>
);

const MODEL_DOTS = ["var(--claude)", "var(--codex)", "var(--anti)"];

const MORE_ICONS = [
  "M21 12a9 9 0 0 1-9 9 9 9 0 0 1-6.7-3L3 16|M3 21v-5h5|M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.7 3L21 8|M21 3v5h-5",
  "M3 11l18-5v12L3 14v-3z|M11.6 16.8a3 3 0 1 1-5.8-1.6",
  "M4 4h16v16H4z|M8 9h8|M8 13h6|M8 17h4",
  "M21 21l-4.3-4.3|M11 17a6 6 0 1 0 0-12 6 6 0 0 0 0 12z",
  "M3 4h18v12H3z|M8 20h8|M12 16v4",
];

const dot = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
);

export default async function FeaturesPage() {
  const t = await getDict();
  return (
    <MarketingShell anim={false}>
      <section className="mkt-section mkt-section--tight">
        <div className="mkt-wrap">
          <div className="mkt-pagehead">
            <span className="mkt-pagehead__eyebrow">{t.features.eyebrow}</span>
            <h1>{t.features.title}</h1>
            <p>{t.features.sub}</p>
          </div>

          {/* 客户端一览 */}
          <div className="mkt-block">
            <figure className="mkt-imgframe">
              <img src="/product-shots/client-preview-beautified.png" alt={t.features.shotAlt} />
            </figure>
            <p className="mkt-imgcap">{t.features.shotCaption}</p>
          </div>

          {/* 实时仪表盘 */}
          <div className="mkt-block">
            <h2>{t.features.dashTitle}</h2>
            <div className="mkt-caps">
              {t.features.dash.map((s) => (
                <div className="mkt-cap" key={s.t}>
                  <span className="mkt-cap__icon">{dot}</span>
                  <div><div className="mkt-cap__t">{s.t}</div><p className="mkt-cap__d">{s.d}</p></div>
                </div>
              ))}
            </div>
          </div>

          {/* 模型用量监控 */}
          <div className="mkt-block">
            <h2>{t.features.quotaTitle}</h2>
            <div className="mkt-prose" style={{ marginBottom: "1.25rem" }}>
              <p>{t.features.quotaIntroPre}<strong>{t.features.quotaIntroStrong}</strong>{t.features.quotaIntroPost}</p>
            </div>
            <div className="mkt-spec">
              {t.features.models.map((m, i) => (
                <div className="mkt-spec__item" key={m.name} style={{ ["--dot" as string]: MODEL_DOTS[i] }}>
                  <span className="mkt-spec__name">{m.name}<span style={{ fontFamily: "var(--font-mono), monospace", fontSize: "0.78rem", color: "var(--ink-muted)", fontWeight: 400 }}>{m.win}</span></span>
                  <p className="mkt-cap__d" style={{ margin: 0 }}>{m.desc}</p>
                </div>
              ))}
            </div>
            <div className="mkt-note">
              <div className="mkt-note__h">{ic("M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1h6c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z|M9 18h6|M10 22h4")}{t.features.resetNoteTitle}</div>
              <p>{t.features.resetNote}</p>
            </div>
          </div>

          {/* 接管控制 */}
          <div className="mkt-block">
            <h2>{t.features.takeoverTitle}</h2>
            <div className="mkt-prose" style={{ marginBottom: "1.25rem" }}>
              <p>{t.features.takeoverIntroPre}<strong>{t.features.takeoverIntroStrong}</strong>{t.features.takeoverIntroPost}</p>
            </div>
            <div className="mkt-fgrid">
              {t.features.takeover.map((p) => (
                <div className="mkt-fcard" key={p.name} style={{ display: "flex", alignItems: "center", gap: "0.8rem" }}>
                  <span className="mkt-fcard__icon" style={{ margin: 0, flexShrink: 0 }}>{dot}</span>
                  <div><div className="mkt-fcard__t" style={{ marginBottom: 0 }}>{p.name}</div><div className="mkt-fcard__d">{p.s}</div></div>
                </div>
              ))}
            </div>
          </div>

          {/* 更多亮点 */}
          <div className="mkt-block">
            <h2>{t.features.moreTitle}</h2>
            <div className="mkt-fgrid">
              {t.features.more.map((h, i) => (
                <div className="mkt-fcard" key={h.t}>
                  <span className="mkt-fcard__icon">{ic(MORE_ICONS[i])}</span>
                  <div className="mkt-fcard__t">{h.t}</div>
                  <div className="mkt-fcard__d">{h.d}</div>
                </div>
              ))}
            </div>
          </div>

          {/* 设置 */}
          <div className="mkt-block">
            <h2>{t.features.settingsTitle}</h2>
            <div className="mkt-spec">
              {t.features.settings.map(([n, d]) => (
                <div className="mkt-spec__item" key={n}>
                  <span className="mkt-spec__name">{n}</span>
                  <p className="mkt-cap__d" style={{ margin: 0 }}>{d}</p>
                </div>
              ))}
            </div>
          </div>

          {/* CTA */}
          <div className="mkt-cta" style={{ marginTop: "1rem" }}>
            <div className="mkt-hero__glow" />
            <h2>{t.features.ctaTitle}</h2>
            <p>{t.features.ctaSub}</p>
            <div className="mkt-cta__btns">
              <a href="/download" className="mkt-btn mkt-btn--primary">{t.common.downloadClient}</a>
              <a href="https://bcai.store" target="_blank" rel="noopener noreferrer" className="mkt-btn mkt-btn--ghost">{t.common.buyCard}</a>
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
