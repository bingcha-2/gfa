"use client";

import { useState, useMemo } from "react";

type FaqItem = {
  id: string;
  category: string;
  question: string;
  answer: string; // rich HTML
  sortOrder: number;
};

type FaqPageProps = {
  faqs: FaqItem[];
  contactWechat?: string;
  contactQrcodeUrl?: string;
};

export function FaqPage({ faqs, contactWechat, contactQrcodeUrl }: FaqPageProps) {
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [openCategories, setOpenCategories] = useState<Set<string>>(new Set());

  function toggleCategory(category: string) {
    setOpenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }

  // Group by category
  const grouped = useMemo(() => {
    const map = new Map<string, FaqItem[]>();
    for (const faq of faqs) {
      const lower = search.toLowerCase();
      if (
        lower &&
        !faq.question.toLowerCase().includes(lower) &&
        !faq.category.toLowerCase().includes(lower)
      ) continue;
      if (!map.has(faq.category)) map.set(faq.category, []);
      map.get(faq.category)!.push(faq);
    }
    return Array.from(map.entries());
  }, [faqs, search]);

  // When searching, auto-expand all matching categories
  const effectiveOpenCategories = search.trim()
    ? new Set(grouped.map(([cat]) => cat))
    : openCategories;

  return (
    <div className="faq-shell">
      {/* Header */}
      <header className="faq-header">
        <div className="faq-header-inner">
          <h1 className="faq-title">常见问题</h1>
          <p className="faq-subtitle">使用中遇到问题？在这里找到解答。</p>
          <div className="faq-nav-links">
            <a href="https://bcai.store" target="_blank" rel="noopener noreferrer">🍵 冰茶商店</a>
            <a href="https://bcai.online" target="_blank" rel="noopener noreferrer">⚡ 冰茶API</a>
            <a href="https://bcai.site" target="_blank" rel="noopener noreferrer">🖥️ 冰茶AI终端</a>
          </div>
          <input
            className="faq-search"
            type="search"
            placeholder="🔍 搜索问题..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </header>

      {/* Contact card */}
      {(contactWechat || contactQrcodeUrl) && (
        <div className="faq-contact-card">
          <div className="faq-contact-inner">
            <div className="faq-contact-text">
              <h3 className="faq-contact-title">📱 售后客服</h3>
              <p className="faq-contact-desc">如需人工协助，请添加客服微信</p>
              {contactWechat && (
                <div className="faq-contact-wechat">
                  <span className="faq-contact-label">微信号</span>
                  <span className="faq-contact-value">{contactWechat}</span>
                  <button
                    className="faq-contact-copy"
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(contactWechat).then(
                        () => {
                          const btn = document.querySelector('.faq-contact-copy');
                          if (btn) { btn.textContent = '✅ 已复制'; setTimeout(() => { btn.textContent = '复制'; }, 2000); }
                        },
                        () => {}
                      );
                    }}
                  >
                    复制
                  </button>
                </div>
              )}
            </div>
            {contactQrcodeUrl && (
              <div className="faq-contact-qr">
                <img src={contactQrcodeUrl} alt="客服微信二维码" />
                <span className="faq-contact-qr-label">扫码添加客服</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* FAQ body */}
      <div className="faq-body">
        {grouped.length === 0 ? (
          <div className="faq-empty">
            {search ? "没有匹配的问题。" : "暂无常见问题。"}
          </div>
        ) : (
          grouped.map(([category, items]) => {
            const isCategoryOpen = effectiveOpenCategories.has(category);
            return (
              <section key={category} className={`faq-category ${isCategoryOpen ? "open" : ""}`}>
                <button
                  className="faq-category-title"
                  onClick={() => toggleCategory(category)}
                  type="button"
                >
                  <span>{category}</span>
                  <span className="faq-category-count">{items.length} 个问题</span>
                  <span className="faq-category-chevron">{isCategoryOpen ? "▾" : "▸"}</span>
                </button>
                {isCategoryOpen && (
                  <div className="faq-list">
                    {items.map((item) => {
                      const isOpen = openId === item.id;
                      return (
                        <div key={item.id} className={`faq-item ${isOpen ? "open" : ""}`}>
                          <button
                            className="faq-question"
                            onClick={() => setOpenId(isOpen ? null : item.id)}
                            type="button"
                          >
                            <span className="faq-q-text">{item.question}</span>
                            <span className="faq-chevron">{isOpen ? "−" : "+"}</span>
                          </button>
                          {isOpen && (
                            <div
                              className="faq-answer"
                              dangerouslySetInnerHTML={{ __html: item.answer }}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>

      <footer className="faq-footer">
        <p className="faq-footer-copy">© {new Date().getFullYear()} BingCha AI</p>
      </footer>
    </div>
  );
}
