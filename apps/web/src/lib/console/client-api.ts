type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE";

type ApiRequestOptions = {
  method?: ApiMethod;
  token?: string | null;
  body?: unknown;
  search?: Record<string, string | number | boolean | undefined>;
};

/**
 * Admin API paths live ONLY under the console surface (/api/console/*) since
 * the legacy bare aliases (/api/rosetta, /api/accounts, …) were removed
 * server-side. Callers keep passing resource paths ("rosetta/accounts",
 * "orders?…"); the console/ prefix is applied centrally here. Paths already
 * starting with console/ are passed through unchanged.
 */
function withConsolePrefix(path: string): string {
  const rel = path.replace(/^\/+/, "");
  return rel === "console" || rel.startsWith("console/")
    ? rel
    : `console/${rel}`;
}

/**
 * Build a console API URL from a resource path ("rosetta/codex-add-account",
 * "plan-catalog", …). The /api/console/ prefix is applied centrally via
 * withConsolePrefix so callers never hardcode it — a bare "/api/rosetta/…"
 * typo silently 404s under the split-domain console host (the legacy bare
 * aliases were removed server-side). Paths already starting with console/
 * pass through unchanged.
 */
export function consoleApiPath(resource: string): string {
  return `/api/${withConsolePrefix(resource)}`;
}

function buildUrl(path: string, search?: ApiRequestOptions["search"]) {
  const targetPath = consoleApiPath(path);

  if (!search) {
    return targetPath;
  }

  const params = new URLSearchParams();

  Object.entries(search).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  });

  const query = params.toString();
  return query ? `${targetPath}?${query}` : targetPath;
}

function parseApiError(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = (payload as { message?: unknown }).message;

    if (Array.isArray(message)) {
      return message.join(", ");
    }

    if (typeof message === "string") {
      return message;
    }
  }

  return fallback;
}

function safeParseJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {}
) {
  const headers = new Headers({
    accept: "application/json"
  });

  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  if (options.token) {
    headers.set("authorization", `Bearer ${options.token}`);
  }

  const response = await fetch(buildUrl(path, options.search), {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    cache: "no-store"
  });

  const rawText = await response.text();
  const payload = rawText ? safeParseJson(rawText) : null;

  if (!response.ok) {
    throw new Error(
      parseApiError(payload, rawText || `Request failed with status ${response.status}`)
    );
  }

  return payload as T;
}

export function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected request error";
}
