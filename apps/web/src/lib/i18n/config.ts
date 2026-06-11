/**
 * 站点多语言配置。九种语言,简体中文为源语言/兜底。
 * 不引入 i18n 库:cookie 决定语言,服务端组件用 getDict(),客户端组件用 useDict()。
 */

export const LOCALES = [
  "zh-CN",
  "zh-TW",
  "en",
  "ja",
  "ko",
  "es",
  "fr",
  "de",
  "vi",
] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "zh-CN";

export const LOCALE_COOKIE = "bcai_locale";

/** 语言切换器里展示的本族语名称。 */
export const LOCALE_NAMES: Record<Locale, string> = {
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  vi: "Tiếng Việt",
};

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

/**
 * 把任意语言标签(cookie 值或 Accept-Language 项)归一到受支持的 Locale。
 * zh 系细分:TW/HK/MO/Hant → 繁體,其余 → 简体;其它语言按主语言前缀匹配。
 */
export function matchLocale(tag: string): Locale | null {
  const t = tag.trim().toLowerCase();
  if (!t) return null;
  if (isLocale(tag)) return tag;
  if (t.startsWith("zh")) {
    if (/hant|tw|hk|mo/.test(t)) return "zh-TW";
    return "zh-CN";
  }
  const primary = t.split(/[-_]/)[0];
  const hit = LOCALES.find((l) => l.toLowerCase().split("-")[0] === primary);
  return hit ?? null;
}

/** 解析 Accept-Language 头,返回最佳匹配(无匹配 → 默认语言)。 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const tags = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="));
      return { tag, q: q ? parseFloat(q.slice(2)) || 0 : 1 };
    })
    .sort((a, b) => b.q - a.q);
  for (const { tag } of tags) {
    const hit = matchLocale(tag);
    if (hit) return hit;
  }
  return DEFAULT_LOCALE;
}
