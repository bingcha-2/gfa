import {
  Activity,
  ChartNoAxesColumnIncreasing,
  Check,
  Cloud,
  CreditCard,
  Download,
  Gauge,
  KeyRound,
  LockKeyhole,
  MonitorCheck,
  RotateCw,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { MarketingShell } from "@/components/marketing/shell";
import { fmt } from "@/lib/i18n";
import { getDict } from "@/lib/i18n/server";
import { ACCOUNT_URL } from "@/lib/account/portal-url";

const ECO_LOGOS = ["/logos/antigravity.svg", "/logos/codex.svg", "/logos/claude.svg"];
const CAP_ICONS = [Gauge, UsersRound, ShieldCheck, ChartNoAxesColumnIncreasing, Activity];
const PORTAL_ICONS = [CreditCard, MonitorCheck, ChartNoAxesColumnIncreasing, KeyRound];

export default async function HomePage() {
  const t = await getDict();
  return (
    <MarketingShell>
      <section className="mkt-hero">
        <div className="mkt-hero__glow" />
        <div className="mkt-wrap mkt-shell-grid">
          <div className="mkt-hero__copy">
            <span className="mkt-eyebrow mkt-reveal" data-d="1">{t.home.eyebrow}</span>
            <h1 className="mkt-h1">
              <span className="mkt-h1__line"><span className="mkt-h1__in">{t.home.h1Line1}</span></span>
              <span className="mkt-h1__line"><span className="mkt-h1__in">{t.home.h1Line2Prefix}<span className="accent">{t.home.h1Line2Accent}</span></span></span>
            </h1>
            <p className="mkt-hero__sub mkt-reveal" data-d="2">{t.home.sub}</p>
            <div className="mkt-hero__cta mkt-reveal" data-d="3">
              <a href="/download" className="mkt-btn mkt-btn--primary">
                <Download aria-hidden />
                {t.common.downloadClient}
              </a>
              <a href={ACCOUNT_URL} className="mkt-btn mkt-btn--ghost">
                <UsersRound aria-hidden />
                {t.common.userCenter}
              </a>
            </div>
          </div>

          <div className="mkt-hero-media mkt-reveal" data-d="2">
            <figure className="mkt-product-shot">
              <img
                src="/product-shots/client-preview-beautified.png"
                alt={t.features.shotAlt}
                width={1280}
                height={838}
              />
            </figure>
            <aside className="mkt-member-pass" aria-label={t.home.portalTitle}>
              <div className="mkt-member-pass__top">
                <span className="mkt-member-pass__brand">
                  <img src="/bcai-icon.png" alt="" width={28} height={28} />
                  {t.common.brandName}
                </span>
                <span className="mkt-member-pass__status">ACTIVE</span>
              </div>
              <div className="mkt-member-pass__plan">{t.home.portalTitle}</div>
              <div className="mkt-member-pass__row">
                <span className="mkt-member-pass__label">{t.home.portalItems[0]}</span>
                <span className="mkt-member-pass__value">BCAI-2026</span>
              </div>
            </aside>
          </div>
        </div>
      </section>

      <section className="mkt-section mkt-section--alt" id="products">
        <div className="mkt-wrap">
          <div className="mkt-section-head">
            <h2 className="mkt-h2">{t.home.ecosystemsTitle}</h2>
            <p className="mkt-lead">{t.home.ecosystemsLead}</p>
          </div>
          <div className="mkt-logo-band">
            {t.home.ecosystems.map((e, i) => (
              <article className="mkt-logo-tile" key={e.name}>
                <span className="mkt-logo-tile__mark">
                  <img src={ECO_LOGOS[i]} alt={fmt(t.home.logoAlt, { name: e.name })} width={28} height={28} loading="lazy" />
                </span>
                <b>{e.name}</b>
                <span>{e.desc}</span>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mkt-section" id="how">
        <div className="mkt-wrap mkt-shell-grid mkt-shell-grid--reverse">
          <div className="mkt-feature-band mkt-feature-band--accent">
            <div className="mkt-process">
              {t.home.how.map((s) => (
                <article className="mkt-process__item" key={s.t}>
                  <div>
                    <h3>{s.t}</h3>
                    <p>{s.d}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
          <div className="mkt-feature-band__content">
            <span className="mkt-kicker">{t.home.quickstartLabel}</span>
            <h2>{t.home.howTitle}</h2>
            <p>{t.home.howLead}</p>
            <a href="/how-it-works" className="mkt-btn mkt-btn--ghost">{t.nav.howItWorks}</a>
          </div>
        </div>
      </section>

      <section className="mkt-section mkt-section--alt" id="capabilities">
        <div className="mkt-wrap">
          <div className="mkt-feature-band mkt-feature-band--split">
            <div className="mkt-feature-band__content">
              <h2>{t.home.capsTitle}</h2>
              <p>{t.home.capsLead}</p>
            </div>
            <div className="mkt-feature-band__rows">
              {t.home.caps.map((c, i) => {
                const Icon = CAP_ICONS[i] ?? Check;
                return (
                  <article className="mkt-feature-row" key={c.t}>
                    <b><Icon aria-hidden /> {c.t}</b>
                    <span>{c.d}</span>
                  </article>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="mkt-section" id="trust">
        <div className="mkt-wrap">
          <div className="mkt-support-panel">
            <div className="mkt-feature-band__content">
              <h2>{t.home.trustTitle}</h2>
              <p>{t.home.trustLead}</p>
            </div>
            <div className="mkt-flow" aria-hidden>
              <div className="mkt-flow__group">
                {ECO_LOGOS.map((src) => (
                  <span className="mkt-flow__node" key={src}>
                    <img src={src} alt="" width={26} height={26} loading="lazy" />
                  </span>
                ))}
              </div>
              <span className="mkt-flow__wire" />
              <span className="mkt-flow__node mkt-flow__node--brand">
                <img src="/bcai-icon.png" alt="" width={34} height={34} />
              </span>
              <span className="mkt-flow__wire" />
              <span className="mkt-flow__node mkt-flow__node--official">
                <Cloud aria-hidden />
              </span>
            </div>
            <div className="mkt-support-panel__grid">
              {t.home.trustPoints.map((p) => (
                <article className="mkt-support-panel__item" key={p.b}>
                  <b><ShieldCheck aria-hidden /> {p.b}</b>
                  <span>{p.s}</span>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="mkt-section mkt-section--alt" id="account">
        <div className="mkt-wrap">
          <div className="mkt-feature-band mkt-feature-band--split">
            <div className="mkt-feature-band__content">
              <h2>{t.home.portalTitle}</h2>
              <p>{t.home.portalLead}</p>
              <a href={ACCOUNT_URL} className="mkt-btn mkt-btn--primary">
                <UsersRound aria-hidden />
                {t.home.portalCta}
              </a>
            </div>
            <div className="mkt-support-panel__grid">
              {t.home.portalItems.map((label, i) => {
                const Icon = PORTAL_ICONS[i] ?? LockKeyhole;
                return (
                  <article className="mkt-support-panel__item" key={label}>
                    <b><Icon aria-hidden /> {label}</b>
                    <span>{t.home.quickstartSteps[i] ?? t.common.userCenter}</span>
                  </article>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="mkt-section mkt-section--tight">
        <div className="mkt-wrap">
          <div className="mkt-final-cta">
            <h2>{t.home.ctaTitle}</h2>
            <p>{t.home.ctaSub}</p>
            <div className="mkt-final-cta__actions">
              <a href="/download" className="mkt-btn mkt-btn--primary"><Download aria-hidden />{t.common.downloadClient}</a>
              <a href={ACCOUNT_URL} className="mkt-btn mkt-btn--ghost"><RotateCw aria-hidden />{t.common.userCenter}</a>
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
