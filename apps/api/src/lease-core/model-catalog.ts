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

export interface ModelCatalog {
  list(): ModelInfo[];
  classify(modelKey: string): string;
  /** Best-effort upstream refresh; must not throw. */
  refresh(getToken: () => Promise<string>): Promise<void>;
}

/** Title-case a model id into a reasonable display name fallback. */
export function defaultDisplayName(key: string): string {
  return key
    .split(/[-_]/)
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}
