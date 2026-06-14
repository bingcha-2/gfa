/**
 * Cross-host links to the public marketing site.
 *
 * In split-domain deploys the portal lives on ACCOUNT_HOST (e.g. my.bcai.space)
 * and the host-isolation middleware 404s every non-/account path — so a bare
 * "/download" or "/" link to the marketing pages is unreachable from here.
 * Set NEXT_PUBLIC_MARKETING_ORIGIN (e.g. "https://bcai.space") and these links
 * become absolute cross-host URLs.
 *
 * Unset (single-domain deploy / local dev): marketing pages share this origin,
 * so a relative path works and is returned as-is. The value is read at build
 * time (NEXT_PUBLIC_*), so it is available in both client and server components.
 */
const MARKETING_ORIGIN = (process.env.NEXT_PUBLIC_MARKETING_ORIGIN ?? "").replace(/\/+$/, "");

/** Absolute URL to a marketing-site path when an origin is configured, else the
 *  relative path unchanged. `path` should start with "/". */
export function marketingUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return MARKETING_ORIGIN ? `${MARKETING_ORIGIN}${p}` : p;
}
