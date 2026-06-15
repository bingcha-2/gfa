import type { Metadata } from "next";
import { Check, CreditCard, Download, KeyRound, MonitorCheck, ToggleRight } from "lucide-react";
import { MarketingShell } from "@/components/marketing/shell";
import { getDict } from "@/lib/i18n/server";
import { ACCOUNT_URL } from "@/lib/account/portal-url";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getDict();
  return { title: t.meta.quickstartTitle, description: t.meta.quickstartDescription };
}

const STEP_ICONS = [Download, CreditCard, ToggleRight, MonitorCheck];

export default async function QuickstartPage() {
  const t = await getDict();
  const cardSpecs = [
    {
      label: t.quickstart.cardBuyLabel,
      value: (
        <>
          {t.quickstart.cardBuyPre}
          <a href={ACCOUNT_URL}>{t.common.userCenter}</a>
          {t.quickstart.cardBuyPost}
        </>
      ),
    },
    { label: t.quickstart.cardExpiryLabel, value: t.quickstart.cardExpiry },
    { label: t.quickstart.cardRenewLabel, value: t.quickstart.cardRenew },
    { label: t.quickstart.cardPlanLabel, value: t.quickstart.cardPlan },
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

          <div className="mkt-shell-grid mkt-block">
            <div className="mkt-feature-band__content">
              <h2>{t.quickstart.title}</h2>
              <p>{t.quickstart.sub}</p>
              <div className="mkt-final-cta__actions">
                <a href="/download" className="mkt-btn mkt-btn--primary">{t.quickstart.goDownload}</a>
                <a href={ACCOUNT_URL} className="mkt-btn mkt-btn--ghost">{t.common.userCenter}</a>
              </div>
            </div>
            <div className="mkt-process">
              {t.quickstart.steps.map((s, i) => {
                const Icon = STEP_ICONS[i] ?? Check;
                return (
                  <article className="mkt-process__item" key={s.t}>
                    <div>
                      <h3><Icon aria-hidden /> {s.t}</h3>
                      <p>{s.d}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>

          <div className="mkt-support-panel mkt-block">
            <div className="mkt-feature-band__content">
              <h2>{t.quickstart.cardTitle}</h2>
              <p>{t.quickstart.cardWhat}</p>
            </div>
            <div className="mkt-support-panel__grid">
              {cardSpecs.map((item) => (
                <article className="mkt-support-panel__item" key={item.label}>
                  <b><KeyRound aria-hidden /> {item.label}</b>
                  <span>{item.value}</span>
                </article>
              ))}
            </div>
          </div>

          <div className="mkt-feature-band mkt-feature-band--split mkt-block">
            <div className="mkt-feature-band__content">
              <h2>{t.quickstart.takeoverTitle}</h2>
              <p>{t.quickstart.takeoverIntro}</p>
            </div>
            <div className="mkt-feature-band__rows">
              {t.quickstart.takeover.map(([n, d]) => (
                <article className="mkt-feature-row" key={n as string}>
                  <b>{n}</b>
                  <p>{d}</p>
                </article>
              ))}
            </div>
          </div>

          <div className="mkt-final-cta">
            <h2>{t.quickstart.ctaTitle}</h2>
            <p>{t.quickstart.ctaSub}</p>
            <div className="mkt-final-cta__actions">
              <a href={ACCOUNT_URL} className="mkt-btn mkt-btn--primary">{t.common.userCenter}</a>
              <a href="/download" className="mkt-btn mkt-btn--ghost">{t.common.downloadClient}</a>
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
