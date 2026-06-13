"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, GlobeIcon } from "lucide-react";

import { LOCALES, LOCALE_NAMES, type Locale } from "@/lib/i18n/config";
import { setLocaleCookie, useLocale } from "@/lib/i18n/client";

/**
 * Account-area language switcher — the marketing site's switcher restyled with
 * the account topnav atoms (account-iconbtn trigger + usermenu-style dropdown).
 * Writes the locale cookie, then router.refresh() so server components re-render.
 */
export function AccountLocaleSwitcher() {
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
    <div className="account-langmenu" ref={rootRef}>
      <button
        type="button"
        className="account-iconbtn"
        aria-label="Language"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={LOCALE_NAMES[locale]}
        onClick={() => setOpen((v) => !v)}
      >
        <GlobeIcon />
      </button>
      {open && (
        <div
          className="account-usermenu__content account-langmenu__menu"
          role="listbox"
          aria-label="Language"
        >
          {LOCALES.map((l) => (
            <button
              key={l}
              type="button"
              role="option"
              aria-selected={l === locale}
              data-active={l === locale || undefined}
              onClick={() => select(l)}
            >
              <CheckIcon data-langmenu-check />
              {LOCALE_NAMES[l]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
