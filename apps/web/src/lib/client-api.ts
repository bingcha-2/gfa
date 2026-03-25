type ApiMethod = "GET" | "POST" | "PATCH";

type ApiRequestOptions = {
  method?: ApiMethod;
  token?: string | null;
  body?: unknown;
  search?: Record<string, string | number | boolean | undefined>;
};

function buildUrl(path: string, search?: ApiRequestOptions["search"]) {
  const targetPath = `/api/proxy/${path.replace(/^\/+/, "")}`;

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
