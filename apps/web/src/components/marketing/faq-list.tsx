"use client";

import { useMemo, useState } from "react";
import { fmt } from "@/lib/i18n";
import { useDict } from "@/lib/i18n/client";

type FaqItem = { id: string; category: string; question: string; answer: string; sortOrder: number };

export function FaqList({
  faqs,
  contactWechat,
  contactQrcodeUrl,
}: {
  faqs: FaqItem[];
  contactWechat?: string;
  contactQrcodeUrl?: string;
}) {
  const t = useDict();
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [closedCats, setClosedCats] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  const grouped = useMemo(() => {
    const map = new Map<string, FaqItem[]>();
    const q = search.trim().toLowerCase();
    for (const f of faqs) {
      if (q && !f.question.toLowerCase().includes(q) && !f.category.toLowerCase().includes(q)) continue;
      if (!map.has(f.category)) map.set(f.category, []);
      map.get(f.category)!.push(f);
    }
    return Array.from(map.entries());
  }, [faqs, search]);

  const searching = search.trim().length > 0;

  function copyWechat() {
    if (!contactWechat) return;
    navigator.clipboard.writeText(contactWechat).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  }

  return (
    <div className="mkt-faq">
      {(contactWechat || contactQrcodeUrl) && (
        <div className="mkt-faq__contact mkt-support-panel__item">
          <div>
            <div className="mkt-faq__contact-t">{t.faqPage.contactTitle}</div>
            <div className="mkt-faq__contact-d">{t.faqPage.contactDesc}</div>
            {contactWechat && (
              <div className="mkt-faq__wechat">
                <code>{contactWechat}</code>
                <button type="button" className="mkt-faq__copy" onClick={copyWechat}>
                  {copied ? t.faqPage.copied : t.faqPage.copy}
                </button>
              </div>
            )}
          </div>
          {contactQrcodeUrl && (
            <div className="mkt-faq__qr">
              <img src={contactQrcodeUrl} alt={t.faqPage.qrAlt} />
              {t.faqPage.scanToAdd}
            </div>
          )}
        </div>
      )}

      <input
        className="mkt-faq__search"
        type="search"
        placeholder={t.faqPage.searchPlaceholder}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label={t.faqPage.searchAria}
      />

      {grouped.length === 0 ? (
        <div className="mkt-faq__empty">{searching ? t.faqPage.noMatch : t.faqPage.empty}</div>
      ) : (
        grouped.map(([category, items]) => {
          const open = searching || !closedCats.has(category);
          return (
            <section className="mkt-faq__cat" key={category}>
              <button
                type="button"
                className="mkt-faq__cathead"
                onClick={() =>
                  setClosedCats((prev) => {
                    const next = new Set(prev);
                    next.has(category) ? next.delete(category) : next.add(category);
                    return next;
                  })
                }
                aria-expanded={open}
              >
                <span>{category}</span>
                <span className="mkt-faq__count">{fmt(t.faqPage.questionCount, { n: items.length })}</span>
                <span className="mkt-faq__chev">{open ? "▾" : "▸"}</span>
              </button>
              {open &&
                items.map((item) => {
                  const isOpen = openId === item.id;
                  return (
                    <div className="mkt-faq__item" key={item.id}>
                      <button
                        type="button"
                        className="mkt-faq__q"
                        onClick={() => setOpenId(isOpen ? null : item.id)}
                        aria-expanded={isOpen}
                      >
                        <span>{item.question}</span>
                        <span className="mkt-faq__plus">{isOpen ? "−" : "+"}</span>
                      </button>
                      {isOpen && <div className="mkt-faq__a" dangerouslySetInnerHTML={{ __html: item.answer }} />}
                    </div>
                  );
                })}
            </section>
          );
        })
      )}
    </div>
  );
}
