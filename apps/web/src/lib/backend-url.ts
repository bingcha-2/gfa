/**
 * Shared backend-URL + response-parsing helpers for portal route handlers.
 *
 * Route-safe: deliberately NO "server-only" import so this can be used from
 * Next.js route handlers, server components and tests alike. Never import
 * this into client components — the URL is a server-side concern.
 */

/** Resolve the NestJS backend base URL (e.g. http://localhost:3001/api). */
export function getBackendBaseUrl(): string {
  return (
    process.env.API_BASE_URL ??
    process.env.NEXT_PUBLIC_API_BASE_URL ??
    "http://localhost:3001/api"
  );
}

/**
 * Parse a backend response body without throwing.
 * Non-JSON bodies (Caddy/NestJS HTML error pages, plain text) return null
 * so callers can substitute a structured error instead of crashing with 500.
 */
export function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
