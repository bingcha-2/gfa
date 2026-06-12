"use client";

import { useCallback, useEffect, useState } from "react";
import { useDict } from "@/lib/i18n/client";

/** 在首屏 paint 前同步初始主题，避免闪烁。注入到 <body> 顶部。 */
// 深色优先:与用户中心(account)一致,新访客默认深色;尊重已存的选择,浅色一键可切。
export const themeInitScript = `(function(){try{var k='mkt-theme';var s=localStorage.getItem(k);var d=s?s==='dark':true;document.documentElement.dataset.mkt=d?'dark':'light';}catch(e){document.documentElement.dataset.mkt='dark';}})();`;

const Moon = () => (
  <svg className="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);
const Sun = () => (
  <svg className="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
);

export function ThemeToggle() {
  const t = useDict();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const toggle = useCallback(() => {
    const root = document.documentElement;
    const next = root.dataset.mkt === "dark" ? "light" : "dark";
    root.dataset.mkt = next;
    try {
      localStorage.setItem("mkt-theme", next);
    } catch {
      /* 隐私模式忽略 */
    }
  }, []);

  return (
    <button
      type="button"
      className="mkt-iconbtn"
      onClick={toggle}
      aria-label={t.nav.toggleTheme}
      title={t.nav.toggleTheme}
    >
      {mounted ? (
        <>
          <Moon />
          <Sun />
        </>
      ) : (
        <Moon />
      )}
    </button>
  );
}
