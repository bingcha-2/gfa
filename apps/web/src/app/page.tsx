import { MarketingShell } from "./_marketing/shell";
import { ClientMock } from "./_marketing/client-mock";
import { fmt } from "@/lib/i18n";
import { getDict } from "@/lib/i18n/server";

/* ───────── 图标 ───────── */
const I = {
  download: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  rotate: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />
    </svg>
  ),
  chart: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 3v18h18M7 15l3-4 3 2 4-6" />
    </svg>
  ),
  zap: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13 2 3 14h8l-1 8 10-12h-8l1-8z" />
    </svg>
  ),
  lock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  ),
  sliders: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  globe: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  ),
};

const ECO_LOGOS = ["/logos/antigravity.svg", "/logos/codex.svg", "/logos/claude.svg"];
const CAP_ICONS = [I.sliders, I.users, I.shield, I.chart, I.zap];

export default async function HomePage() {
  const t = await getDict();
  return (
    <MarketingShell>
        {/* ════ Hero ════ */}
        <section className="mkt-hero">
          <div className="mkt-hero__glow" />
          <div className="mkt-wrap mkt-hero__grid">
            <div className="mkt-hero__copy">
              <span className="mkt-eyebrow mkt-reveal" data-d="1">{t.home.eyebrow}</span>
              <h1 className="mkt-h1">
                <span className="mkt-h1__line"><span className="mkt-h1__in">{t.home.h1Line1}</span></span>
                <span className="mkt-h1__line"><span className="mkt-h1__in">{t.home.h1Line2Prefix}<span className="accent">{t.home.h1Line2Accent}</span></span></span>
              </h1>
              <p className="mkt-hero__sub mkt-reveal" data-d="2">
                {t.home.sub}
              </p>
              <div className="mkt-hero__cta mkt-reveal" data-d="3">
                <a href="/download" className="mkt-btn mkt-btn--primary">
                  {I.download}
                  {t.common.downloadClient}
                </a>
                <a href="https://bcai.store" target="_blank" rel="noopener noreferrer" className="mkt-btn mkt-btn--ghost">
                  {t.common.buyCard}
                </a>
              </div>
              <div className="mkt-hero__trust mkt-reveal" data-d="4">
                <span>{I.check}{t.home.trust1}</span>
                <span>{I.check}{t.home.trust2}</span>
                <span>{I.check}{t.home.trust3}</span>
              </div>
            </div>
            <div className="mkt-hero__mock">
              <ClientMock />
            </div>
          </div>
        </section>

        {/* ════ 支持的工具 ════ */}
        <section className="mkt-section mkt-section--alt" id="products">
          <div className="mkt-wrap">
            <div className="mkt-section-head">
              <h2 className="mkt-h2">{t.home.ecosystemsTitle}</h2>
              <p className="mkt-lead">{t.home.ecosystemsLead}</p>
            </div>
            <div className="mkt-grid-3">
              {t.home.ecosystems.map((e, i) => (
                <article className="mkt-eco" key={e.name}>
                  <span className="mkt-eco__logo">
                    <img src={ECO_LOGOS[i]} alt={fmt(t.home.logoAlt, { name: e.name })} width={28} height={28} loading="lazy" />
                  </span>
                  <div>
                    <div className="mkt-eco__name">{e.name}</div>
                    <div className="mkt-eco__tag">{e.tag}</div>
                  </div>
                  <p className="mkt-eco__desc">{e.desc}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ════ 工作原理 ════ */}
        <section className="mkt-section" id="how">
          <div className="mkt-wrap">
            <div className="mkt-section-head">
              <h2 className="mkt-h2">{t.home.howTitle}</h2>
              <p className="mkt-lead">
                {t.home.howLead}
              </p>
            </div>
            <div className="mkt-steps">
              {t.home.how.map((s, i) => (
                <div className="mkt-step" key={s.t}>
                  <span className="mkt-step__n">{i + 1}</span>
                  <div className="mkt-step__t">{s.t}</div>
                  <p className="mkt-step__d">{s.d}</p>
                </div>
              ))}
            </div>

            <div className="mkt-quickstart">
              <span className="mkt-quickstart__label">{t.home.quickstartLabel}</span>
              {t.home.quickstartSteps.map((q, i) => (
                <span className="mkt-qs" key={q}>
                  <span className="mkt-qs__n">{i + 1}</span>
                  <span className="mkt-qs__t">{q}</span>
                  {i < t.home.quickstartSteps.length - 1 && <span className="mkt-qs__arrow" aria-hidden>→</span>}
                </span>
              ))}
              <span className="mkt-quickstart__note">{t.home.quickstartNote}</span>
            </div>
          </div>
        </section>

        {/* ════ 核心能力 ════ */}
        <section className="mkt-section mkt-section--alt" id="capabilities">
          <div className="mkt-wrap">
            <div className="mkt-section-head">
              <h2 className="mkt-h2">{t.home.capsTitle}</h2>
              <p className="mkt-lead">{t.home.capsLead}</p>
            </div>
            <div className="mkt-caps">
              {t.home.caps.map((c, i) => (
                <div className="mkt-cap" key={c.t}>
                  <span className="mkt-cap__icon">{CAP_ICONS[i]}</span>
                  <div>
                    <div className="mkt-cap__t">{c.t}</div>
                    <p className="mkt-cap__d">{c.d}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ════ 对比 ════ */}
        <section className="mkt-section">
          <div className="mkt-wrap">
            <div className="mkt-section-head">
              <h2 className="mkt-h2">{t.home.compareTitle}</h2>
              <p className="mkt-lead">{t.home.compareLead}</p>
            </div>
            <div className="mkt-compare">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th className="col-us">{t.home.compareColUs}</th>
                    <th>{t.home.compareColOwn}</th>
                    <th>{t.home.compareColRelay}</th>
                  </tr>
                </thead>
                <tbody>
                  {t.home.compareRows.map(([label, us, own, relay]) => (
                    <tr key={label}>
                      <td>{label}</td>
                      <td className="col-us">{us}</td>
                      <td className="col-other">{own}</td>
                      <td className="col-other">{relay}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ════ 安全承诺 ════ */}
        <section className="mkt-section mkt-section--alt" id="trust">
          <div className="mkt-wrap">
            <div className="mkt-trust">
              <div className="mkt-trust__head">
                <span className="mkt-trust__badge">{I.lock}</span>
                <div>
                  <h2 className="mkt-h2" style={{ fontSize: "clamp(1.5rem, 2.4vw, 2rem)" }}>{t.home.trustTitle}</h2>
                  <p className="mkt-lead" style={{ marginTop: "0.35rem" }}>
                    {t.home.trustLead}
                  </p>
                </div>
              </div>
              <div className="mkt-trust__points">
                {t.home.trustPoints.map((p) => (
                  <div className="mkt-trust__point" key={p.b}>
                    <b>{I.check}{p.b}</b>
                    <span>{p.s}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ════ 底部 CTA ════ */}
        <section className="mkt-section mkt-section--tight">
          <div className="mkt-wrap">
            <div className="mkt-cta">
              <div className="mkt-hero__glow" />
              <h2>{t.home.ctaTitle}</h2>
              <p>{t.home.ctaSub}</p>
              <div className="mkt-cta__btns">
                <a href="/download" className="mkt-btn mkt-btn--primary">{I.download}{t.common.downloadClient}</a>
                <a href="https://bcai.store" target="_blank" rel="noopener noreferrer" className="mkt-btn mkt-btn--ghost">{t.common.buyCard}</a>
              </div>
            </div>
          </div>
        </section>

    </MarketingShell>
  );
}
