"use client";

import { createContext, useContext, type ReactNode } from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  type Locale,
} from "./config";
import { getDictionary, type Dict } from "./index";

type LocaleContextValue = { locale: Locale; dict: Dict };

const LocaleContext = createContext<LocaleContextValue>({
  locale: DEFAULT_LOCALE,
  dict: getDictionary(DEFAULT_LOCALE),
});

/** 根布局(服务端)注入当前语言;客户端组件经 useDict()/useLocale() 消费。 */
export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  return (
    <LocaleContext.Provider value={{ locale, dict: getDictionary(locale) }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale(): Locale {
  return useContext(LocaleContext).locale;
}

export function useDict(): Dict {
  return useContext(LocaleContext).dict;
}

/** 写语言 cookie(一年)。调用后需 router.refresh() 让服务端重渲。 */
export function setLocaleCookie(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}
