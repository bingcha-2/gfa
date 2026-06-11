import type { Metadata } from "next";
import { MarketingShell } from "@/components/marketing/shell";
import { getDict } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getDict();
  return { title: t.meta.howTitle, description: t.meta.howDescription };
}

const Bulb = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1h6c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" />
  </svg>
);
const Lock = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);
const Check = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const PRODUCT_DOTS = ["var(--anti)", "var(--codex)", "var(--claude)"];

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

          {/* 架构概述 */}
          <div className="mkt-block">
            <h2>{t.how.archTitle}</h2>
            <div className="mkt-prose">
              <p>
                {t.how.archP1Pre}<strong>{t.how.archP1Strong1}</strong>{t.how.archP1Mid}
                <strong>{t.how.archP1Strong2}</strong>{t.how.archP1Post}
              </p>
            </div>
            <div className="mkt-note">
              <div className="mkt-note__h"><Bulb />{t.how.coreNoteTitle}</div>
              <p>{t.how.coreNote}</p>
            </div>
          </div>

          {/* 请求生命周期 */}
          <div className="mkt-block">
            <h2>{t.how.lifecycleTitle}</h2>
            <div className="mkt-steps">
              {t.how.flow.map((s, i) => (
                <div className="mkt-step" key={s.t}>
                  <span className="mkt-step__n">{i + 1}</span>
                  <div className="mkt-step__t">{s.t}</div>
                  <p className="mkt-step__d">{s.d}</p>
                </div>
              ))}
            </div>
          </div>

          {/* 号池轮换 */}
          <div className="mkt-block">
            <h2>{t.how.poolTitle}</h2>
            <div className="mkt-prose" style={{ marginBottom: "1.25rem" }}>
              <p>{t.how.poolIntro}</p>
            </div>
            <div className="mkt-caps">
              {t.how.pool.map((f) => (
                <div className="mkt-cap" key={f.t}>
                  <span className="mkt-cap__icon"><Check /></span>
                  <div>
                    <div className="mkt-cap__t">{f.t}</div>
                    <p className="mkt-cap__d">{f.d}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 各产品接管体验 */}
          <div className="mkt-block">
            <h2>{t.how.productsTitle}</h2>
            <div className="mkt-spec">
              {t.how.products.map((p, i) => (
                <div className="mkt-spec__item" key={p.name} style={{ ["--dot" as string]: PRODUCT_DOTS[i] }}>
                  <span className="mkt-spec__name">{p.name}</span>
                  <ul className="mkt-spec__list">
                    {p.items.map((h) => <li key={h}>{h}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          {/* 安全模型 */}
          <div className="mkt-block" style={{ marginBottom: 0 }}>
            <h2>{t.how.safetyTitle}</h2>
            <div className="mkt-trust">
              <div className="mkt-trust__head">
                <span className="mkt-trust__badge"><Lock /></span>
                <div>
                  <h3 className="mkt-h2" style={{ fontSize: "clamp(1.4rem, 2.2vw, 1.75rem)" }}>{t.how.safetyHeadline}</h3>
                  <p className="mkt-lead" style={{ marginTop: "0.35rem" }}>{t.how.safetyLead}</p>
                </div>
              </div>
              <div className="mkt-trust__points">
                {t.how.safe.map(([b, s]) => (
                  <div className="mkt-trust__point" key={b}>
                    <b><Check />{b}</b>
                    <span>{s}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
