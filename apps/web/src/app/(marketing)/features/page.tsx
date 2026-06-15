import type { Metadata } from "next";
import {
  Check,
  Gauge,
  MonitorCog,
  RotateCw,
  SearchCheck,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { MarketingShell } from "@/components/marketing/shell";
import { getDict } from "@/lib/i18n/server";
import { ACCOUNT_URL } from "@/lib/account/portal-url";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getDict();
  return { title: t.meta.featuresTitle, description: t.meta.featuresDescription };
}

const MODEL_DOTS = ["var(--claude)", "var(--codex)", "var(--anti)"];
const MORE_ICONS = [RotateCw, MonitorCog, Settings2, SearchCheck, Gauge];

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

          <div className="mkt-feature-band mkt-feature-band--split mkt-feature-band--accent mkt-block">
            <div className="mkt-feature-band__content">
              <span className="mkt-kicker">{t.features.shotCaption}</span>
              <h2>{t.features.dashTitle}</h2>
              <p>{t.features.sub}</p>
            </div>
            <figure className="mkt-product-shot">
              <img src="/product-shots/client-preview-beautified.png" alt={t.features.shotAlt} width={1280} height={838} />
            </figure>
          </div>

          <div className="mkt-shell-grid mkt-block">
            <div className="mkt-feature-band__content">
              <h2>{t.features.quotaTitle}</h2>
              <p>{t.features.quotaIntroPre}<strong>{t.features.quotaIntroStrong}</strong>{t.features.quotaIntroPost}</p>
            </div>
            <div className="mkt-feature-band">
              <div className="mkt-feature-band__rows">
                {t.features.models.map((m, i) => (
                  <article className="mkt-feature-row" key={m.name} style={{ ["--dot" as string]: MODEL_DOTS[i] }}>
                    <b>{m.name} <span>{m.win}</span></b>
                    <p>{m.desc}</p>
                  </article>
                ))}
              </div>
            </div>
          </div>

          <div className="mkt-feature-band mkt-feature-band--split mkt-block">
            <div className="mkt-feature-band__content">
              <h2>{t.features.takeoverTitle}</h2>
              <p>{t.features.takeoverIntroPre}<strong>{t.features.takeoverIntroStrong}</strong>{t.features.takeoverIntroPost}</p>
            </div>
            <div className="mkt-support-panel__grid">
              {t.features.takeover.map((p) => (
                <article className="mkt-support-panel__item" key={p.name}>
                  <b><Check aria-hidden /> {p.name}</b>
                  <span>{p.s}</span>
                </article>
              ))}
            </div>
          </div>

          <div className="mkt-shell-grid mkt-shell-grid--reverse mkt-block">
            <div className="mkt-support-panel">
              <div className="mkt-support-panel__grid">
                {t.features.dash.map((s) => (
                  <article className="mkt-support-panel__item" key={s.t}>
                    <b><Gauge aria-hidden /> {s.t}</b>
                    <span>{s.d}</span>
                  </article>
                ))}
              </div>
            </div>
            <div className="mkt-feature-band__content">
              <h2>{t.features.dashTitle}</h2>
              <p>{t.features.resetNote}</p>
            </div>
          </div>

          <div className="mkt-feature-band mkt-block">
            <div className="mkt-feature-band__content">
              <h2>{t.features.moreTitle}</h2>
            </div>
            <div className="mkt-logo-band">
              {t.features.more.map((h, i) => {
                const Icon = MORE_ICONS[i] ?? ShieldCheck;
                return (
                  <article className="mkt-logo-tile" key={h.t}>
                    <span className="mkt-logo-tile__mark"><Icon aria-hidden /></span>
                    <b>{h.t}</b>
                    <span>{h.d}</span>
                  </article>
                );
              })}
            </div>
          </div>

          <div className="mkt-support-panel mkt-block">
            <div className="mkt-feature-band__content">
              <h2>{t.features.settingsTitle}</h2>
              <p>{t.features.resetNote}</p>
            </div>
            <div className="mkt-support-panel__grid">
              {t.features.settings.map(([n, d]) => (
                <article className="mkt-support-panel__item" key={n}>
                  <b><Settings2 aria-hidden /> {n}</b>
                  <span>{d}</span>
                </article>
              ))}
            </div>
          </div>

          <div className="mkt-final-cta">
            <h2>{t.features.ctaTitle}</h2>
            <p>{t.features.ctaSub}</p>
            <div className="mkt-final-cta__actions">
              <a href="/download" className="mkt-btn mkt-btn--primary">{t.common.downloadClient}</a>
              <a href={ACCOUNT_URL} className="mkt-btn mkt-btn--ghost">{t.common.userCenter}</a>
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
