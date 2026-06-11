import type { Metadata } from "next";
import { MarketingShell } from "../_marketing/shell";
import { getDict } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getDict();
  return { title: t.meta.quickstartTitle, description: t.meta.quickstartDescription };
}

const Card = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20M6 15h4" />
  </svg>
);

export default async function QuickstartPage() {
  const t = await getDict();
  const cardSpecs: Array<[string, React.ReactNode]> = [
    [
      t.quickstart.cardBuyLabel,
      <>
        {t.quickstart.cardBuyPre}
        <a href="https://bcai.store" target="_blank" rel="noopener noreferrer" style={{ color: "var(--primary-text)", fontWeight: 600 }}>bcai.store</a>
        {t.quickstart.cardBuyPost}
      </>,
    ],
    [t.quickstart.cardExpiryLabel, t.quickstart.cardExpiry],
    [t.quickstart.cardRenewLabel, t.quickstart.cardRenew],
    [t.quickstart.cardPlanLabel, t.quickstart.cardPlan],
  ];

  return (
    <MarketingShell anim={false}>
      <section className="mkt-section mkt-section--tight">
        <div className="mkt-wrap">
          <div className="mkt-pagehead">
            <span className="mkt-pagehead__eyebrow">{t.quickstart.eyebrow}</span>
            <h1>{t.quickstart.title}</h1>
            <p>{t.quickstart.sub}</p>
          </div>

          {/* 三步 */}
          <div className="mkt-block">
            <div className="mkt-steps">
              {t.quickstart.steps.map((s, i) => (
                <div className="mkt-step" key={s.t}>
                  <span className="mkt-step__n">{i + 1}</span>
                  <div className="mkt-step__t">{s.t}</div>
                  <p className="mkt-step__d">{s.d}</p>
                  {i === 0 && (
                    <a href="/download" style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--primary-text)" }}>{t.quickstart.goDownload}</a>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 关于卡密 */}
          <div className="mkt-block">
            <h2>{t.quickstart.cardTitle}</h2>
            <div className="mkt-note">
              <div className="mkt-note__h"><Card />{t.quickstart.cardWhatTitle}</div>
              <p>{t.quickstart.cardWhat}</p>
            </div>
            <div className="mkt-spec" style={{ marginTop: "1.5rem" }}>
              {cardSpecs.map(([k, v], i) => (
                <div className="mkt-spec__item" key={i}>
                  <span className="mkt-spec__name">{k}</span>
                  <p className="mkt-cap__d" style={{ margin: 0 }}>{v}</p>
                </div>
              ))}
            </div>
          </div>

          {/* 接管面板 */}
          <div className="mkt-block">
            <h2>{t.quickstart.takeoverTitle}</h2>
            <div className="mkt-prose" style={{ marginBottom: "1.25rem" }}>
              <p>{t.quickstart.takeoverIntro}</p>
            </div>
            <div className="mkt-spec">
              {t.quickstart.takeover.map(([n, d]) => (
                <div className="mkt-spec__item" key={n as string}>
                  <span className="mkt-spec__name">{n}</span>
                  <p className="mkt-cap__d" style={{ margin: 0 }}>{d}</p>
                </div>
              ))}
            </div>
          </div>

          {/* CTA */}
          <div className="mkt-cta" style={{ marginTop: "1rem" }}>
            <div className="mkt-hero__glow" />
            <h2>{t.quickstart.ctaTitle}</h2>
            <p>{t.quickstart.ctaSub}</p>
            <div className="mkt-cta__btns">
              <a href="https://bcai.store" target="_blank" rel="noopener noreferrer" className="mkt-btn mkt-btn--primary">{t.common.buyCard}</a>
              <a href="/download" className="mkt-btn mkt-btn--ghost">{t.common.downloadClient}</a>
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
