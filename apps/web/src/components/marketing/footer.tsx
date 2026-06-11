"use client";

import { useDict } from "@/lib/i18n/client";

/** 营销站统一页脚(首页与所有子页共用)。 */
export function MarketingFooter() {
  const t = useDict();
  return (
    <footer className="mkt-footer">
      <div className="mkt-footer__inner">
        <div className="mkt-footer__brand">
          <a href="/" className="mkt-brand">
            <img className="mkt-brand__mark" src="/bcai-icon.png" alt={t.common.brandName} width={30} height={30} />
            {t.common.brandName}
          </a>
          <p className="mkt-footer__desc">{t.footer.desc}</p>
        </div>
        <div className="mkt-footer__col">
          <h4>{t.footer.product}</h4>
          <a href="/download">{t.footer.download}</a>
          <a href="/features">{t.footer.features}</a>
          <a href="/quickstart">{t.footer.quickstart}</a>
          <a href="/how-it-works">{t.footer.howItWorks}</a>
        </div>
        <div className="mkt-footer__col">
          <h4>{t.footer.help}</h4>
          <a href="/faq">{t.footer.faq}</a>
          <a href="https://bcai.store" target="_blank" rel="noopener noreferrer">{t.footer.store}</a>
          <a href="https://bcai.online" target="_blank" rel="noopener noreferrer">{t.footer.api}</a>
          <a href="https://bcai.lol" target="_blank" rel="noopener noreferrer">{t.footer.terminal}</a>
        </div>
      </div>
      <div className="mkt-footer__bottom">
        <span>{t.footer.copyright}</span>
        <span>{t.footer.tagline}</span>
      </div>
    </footer>
  );
}
