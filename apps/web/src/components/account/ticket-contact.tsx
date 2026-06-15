"use client";

import { useState } from "react";
import { useDict } from "@/lib/i18n/client";

/**
 * 工单页顶部的「售后客服」联系卡:展示客服微信号(可一键复制)+ 客服二维码。
 * 数据与官网 FAQ 同源 —— 都来自 GET /console/faq/settings 的 contact_wechat /
 * contact_qrcode_url(siteSetting 表),改一处全站生效。两者都没配置时不渲染。
 */
export function TicketContact({
  wechat,
  qrcodeUrl,
}: {
  wechat?: string;
  qrcodeUrl?: string;
}) {
  const t = useDict().faqPage;
  const [copied, setCopied] = useState(false);

  if (!wechat && !qrcodeUrl) return null;

  function copyWechat() {
    if (!wechat) return;
    navigator.clipboard.writeText(wechat).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  }

  return (
    <section
      className="account-panel account-support account-support-panel"
      data-testid="account-ticket-contact"
    >
      <div className="account-support__main">
        <div className="account-panel__header">
          <div>
            <h3>{t.contactTitle}</h3>
            <p>{t.contactDesc}</p>
          </div>
        </div>
        {wechat && (
          <div className="account-support__wechat">
            <code>{wechat}</code>
            <button type="button" className="account-support__copy" onClick={copyWechat}>
              {copied ? t.copied : t.copy}
            </button>
          </div>
        )}
      </div>
      {qrcodeUrl && (
        <figure className="account-support__qr">
          {/* 与官网 FAQ 一致用原生 img(外链二维码,无需 next/image 优化) */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrcodeUrl} alt={t.qrAlt} />
          <figcaption>{t.scanToAdd}</figcaption>
        </figure>
      )}
    </section>
  );
}
