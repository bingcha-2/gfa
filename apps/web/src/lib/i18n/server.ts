import { cookies, headers } from "next/headers";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  matchLocale,
  negotiateLocale,
  type Locale,
} from "./config";
import { getDictionary, type Dict } from "./index";

/** 当前请求的语言:cookie 优先,其次 Accept-Language,兜底简中。 */
export async function getLocale(): Promise<Locale> {
  try {
    const store = await cookies();
    const fromCookie = store.get(LOCALE_COOKIE)?.value;
    if (fromCookie) {
      const hit = matchLocale(fromCookie);
      if (hit) return hit;
    }
    const hdrs = await headers();
    return negotiateLocale(hdrs.get("accept-language"));
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** 服务端组件一步取全量字典。 */
export async function getDict(): Promise<Dict> {
  return getDictionary(await getLocale());
}
