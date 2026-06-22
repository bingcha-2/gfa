import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_NAMES,
  matchLocale,
  negotiateLocale,
} from "@/lib/i18n/config";

describe("i18n locales — only Simplified Chinese + English", () => {
  it("supports exactly zh-CN and en", () => {
    expect([...LOCALES]).toEqual(["zh-CN", "en"]);
  });

  it("defaults to zh-CN", () => {
    expect(DEFAULT_LOCALE).toBe("zh-CN");
  });

  it("names every supported locale and nothing else", () => {
    expect(Object.keys(LOCALE_NAMES).sort()).toEqual(["en", "zh-CN"]);
  });

  it("folds any Chinese tag (incl. Traditional) to zh-CN", () => {
    expect(matchLocale("zh-CN")).toBe("zh-CN");
    expect(matchLocale("zh-TW")).toBe("zh-CN");
    expect(matchLocale("zh-HK")).toBe("zh-CN");
    expect(matchLocale("zh-Hant")).toBe("zh-CN");
  });

  it("matches English, rejects dropped languages", () => {
    expect(matchLocale("en-US")).toBe("en");
    expect(matchLocale("ja")).toBeNull();
    expect(matchLocale("ko")).toBeNull();
    expect(matchLocale("de")).toBeNull();
    expect(matchLocale("fr")).toBeNull();
  });

  it("negotiates Accept-Language, falling back to zh-CN for dropped languages", () => {
    expect(negotiateLocale("en-US,en;q=0.9")).toBe("en");
    expect(negotiateLocale("zh-TW,zh;q=0.9")).toBe("zh-CN");
    expect(negotiateLocale("ja-JP,ja;q=0.9")).toBe("zh-CN");
    expect(negotiateLocale(null)).toBe("zh-CN");
  });
});
