import type { Metadata } from "next";
import { Check, Cloud, KeyRound, Laptop, LockKeyhole, Route, ShieldCheck } from "lucide-react";
import { MarketingShell } from "@/components/marketing/shell";
import { getDict } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getDict();
  return { title: t.meta.howTitle, description: t.meta.howDescription };
}

const PRODUCT_DOTS = ["var(--anti)", "var(--codex)", "var(--claude)"];
const FLOW_ICONS = [Laptop, KeyRound, Route, Cloud];

export default async function HowItWorksPage() {
  const t = await getDict();
  return (
    <MarketingShell anim={false}>
      <section className="mkt-section mkt-section--tight">
        <div className="mkt-wrap">
          <div className="mkt-pagehead">
            <span className="mkt-pagehead__eyebrow">{t.how.eyebrow}</span>
            <h1>{t.how.title}</h1>
            <p>{t.how.sub}</p>
          </div>

          <div className="mkt-feature-band mkt-feature-band--split mkt-feature-band--accent mkt-block">
            <div className="mkt-feature-band__content">
              <h2>{t.how.archTitle}</h2>
              <p>
                {t.how.archP1Pre}<strong>{t.how.archP1Strong1}</strong>{t.how.archP1Mid}
                <strong>{t.how.archP1Strong2}</strong>{t.how.archP1Post}
              </p>
            </div>
            <div className="mkt-process">
              {t.how.flow.map((s, i) => {
                const Icon = FLOW_ICONS[i] ?? Check;
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

          <div className="mkt-shell-grid mkt-block">
            <div className="mkt-support-panel">
              <div className="mkt-feature-band__content">
                <h2>{t.how.poolTitle}</h2>
                <p>{t.how.poolIntro}</p>
              </div>
              <div className="mkt-support-panel__grid">
                {t.how.pool.map((f) => (
                  <article className="mkt-support-panel__item" key={f.t}>
                    <b><ShieldCheck aria-hidden /> {f.t}</b>
                    <span>{f.d}</span>
                  </article>
                ))}
              </div>
            </div>
            <div className="mkt-feature-band">
              <div className="mkt-feature-band__content">
                <span className="mkt-kicker">{t.how.coreNoteTitle}</span>
                <h2>{t.how.lifecycleTitle}</h2>
                <p>{t.how.coreNote}</p>
              </div>
            </div>
          </div>

          <div className="mkt-feature-band mkt-block">
            <div className="mkt-feature-band__content">
              <h2>{t.how.productsTitle}</h2>
            </div>
            <div className="mkt-feature-band__rows">
              {t.how.products.map((p, i) => (
                <article className="mkt-feature-row" key={p.name} style={{ ["--dot" as string]: PRODUCT_DOTS[i] }}>
                  <b>{p.name}</b>
                  <p>{p.items.join(" / ")}</p>
                </article>
              ))}
            </div>
          </div>

          <div className="mkt-support-panel">
            <div className="mkt-feature-band__content">
              <h2>{t.how.safetyTitle}</h2>
              <p>{t.how.safetyLead}</p>
            </div>
            <div className="mkt-support-panel__grid">
              {t.how.safe.map(([b, s]) => (
                <article className="mkt-support-panel__item" key={b}>
                  <b><LockKeyhole aria-hidden /> {b}</b>
                  <span>{s}</span>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
