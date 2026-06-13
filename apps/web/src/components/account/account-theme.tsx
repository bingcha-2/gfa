"use client";

import { useCallback, useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "lucide-react";

import { useDict } from "@/lib/i18n/client";

// 深色优先:读不到本地偏好(新访客 / 隐私模式)时默认深色;尊重已存的选择。
export const accountThemeInitScript = `(function(){try{var k='account-theme';var s=localStorage.getItem(k);var d=s?s==='dark':true;document.documentElement.dataset.accountTheme=d?'dark':'light';}catch(e){document.documentElement.dataset.accountTheme='dark';}})();`;

export function AccountThemeScript() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: accountThemeInitScript,
      }}
    />
  );
}

export function AccountThemeToggle({ className }: { className?: string }) {
  const dict = useDict();
  // 初始值与深色优先的初始化脚本一致;挂载后再读真实 dataset 校正。
  const [theme, setTheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    const current =
      document.documentElement.dataset.accountTheme === "dark" ? "dark" : "light";
    setTheme(current);
  }, []);

  const toggle = useCallback(() => {
    const root = document.documentElement;
    const next = root.dataset.accountTheme === "dark" ? "light" : "dark";
    root.dataset.accountTheme = next;
    setTheme(next);
    try {
      localStorage.setItem("account-theme", next);
    } catch {
      /* Private browsing can block storage. */
    }
  }, []);

  return (
    <button
      type="button"
      className={className ? `account-theme-toggle ${className}` : "account-theme-toggle"}
      onClick={toggle}
      aria-label={dict.portalApp.nav.toggleTheme}
      title={dict.portalApp.nav.toggleTheme}
      data-theme={theme}
    >
      <SunIcon data-slot="theme-sun" />
      <MoonIcon data-slot="theme-moon" />
    </button>
  );
}
