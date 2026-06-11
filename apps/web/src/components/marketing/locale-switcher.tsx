"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LOCALES,
  LOCALE_NAMES,
  type Locale,
} from "@/lib/i18n/config";
import { setLocaleCookie, useLocale } from "@/lib/i18n/client";

const GlobeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

/** 顶栏语言切换:地球图标 + 下拉本族语名列表;写 cookie 后 refresh 服务端重渲。 */
export function LocaleSwitcher({ compact = false }: { compact?: boolean }) {
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const select = (next: Locale) => {
    setOpen(false);
    if (next === locale) return;
    setLocaleCookie(next);
    router.refresh();
  };

  return (
    <div className="mkt-lang" ref={rootRef}>
      <button
        type="button"
        className="mkt-iconbtn mkt-lang__btn"
        aria-label="Language"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={LOCALE_NAMES[locale]}
        onClick={() => setOpen((v) => !v)}
      >
        <GlobeIcon />
        {!compact && <span className="mkt-lang__current">{LOCALE_NAMES[locale]}</span>}
      </button>
      {open && (
        <ul className="mkt-lang__menu" role="listbox" aria-label="Language">
          {LOCALES.map((l) => (
            <li key={l}>
              <button
                type="button"
                role="option"
                aria-selected={l === locale}
                className="mkt-lang__item"
                data-active={l === locale}
                onClick={() => select(l)}
              >
                {LOCALE_NAMES[l]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
