/**
 * ModelCatalog — per-provider model registry.
 *
 * Provides the known model list (for /status display, console, validation), a
 * classify() that maps a modelKey to a billing bucket, and a refresh() that
 * pulls the live list from upstream (best-effort; failures keep the seed).
 */

export interface ModelInfo {
  key: string;
  displayName: string;
  bucket: string;
}

/** Auth for an upstream catalog fetch: the leased access token plus the account's
 * sticky exit proxy, so the fetch can pin its egress IP (required for anthropic,
 * best-effort for the others) instead of leaking the datacenter IP. */
export type CatalogAuth = { token: string; proxyUrl?: string };

export interface ModelCatalog {
  list(): ModelInfo[];
  classify(modelKey: string): string;
  /** Best-effort upstream refresh; must not throw. */
  refresh(getAuth: () => Promise<CatalogAuth>): Promise<void>;
}

/** Title-case a model id into a reasonable display name fallback. */
export function defaultDisplayName(key: string): string {
  return key
    .split(/[-_]/)
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}
