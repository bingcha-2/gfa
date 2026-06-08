"use client";

import { useMemo, useState } from "react";

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
        <div className="mkt-faq__contact">
          <div>
            <div className="mkt-faq__contact-t">售后客服</div>
            <div className="mkt-faq__contact-d">需要人工协助？添加客服微信。</div>
            {contactWechat && (
              <div className="mkt-faq__wechat">
                <code>{contactWechat}</code>
                <button type="button" className="mkt-faq__copy" onClick={copyWechat}>
                  {copied ? "已复制" : "复制"}
                </button>
              </div>
            )}
          </div>
          {contactQrcodeUrl && (
            <div className="mkt-faq__qr">
              <img src={contactQrcodeUrl} alt="客服微信二维码" />
              扫码添加
            </div>
          )}
        </div>
      )}

      <input
        className="mkt-faq__search"
        type="search"
        placeholder="搜索问题…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="搜索常见问题"
      />

      {grouped.length === 0 ? (
        <div className="mkt-faq__empty">{searching ? "没有匹配的问题。" : "暂无常见问题。"}</div>
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
                <span className="mkt-faq__count">{items.length} 个问题</span>
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
