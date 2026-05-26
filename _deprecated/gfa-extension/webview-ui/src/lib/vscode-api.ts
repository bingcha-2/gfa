/**
 * VS Code Webview API bridge.
 *
 * All API calls from the webview go through postMessage → Extension Host → GFA API.
 * This file replaces the original client-api.ts which used Next.js /api/proxy/*.
 */

// Declare the VS Code API acquisition function
declare function acquireVsCodeApi(): {
  postMessage(message: any): void;
  getState(): any;
  setState(state: any): void;
};

// Singleton vscode api
let vscodeApi: ReturnType<typeof acquireVsCodeApi> | null = null;

export function getVsCodeApi() {
  if (!vscodeApi) {
    try {
      vscodeApi = acquireVsCodeApi();
    } catch {
      // Running in regular browser (dev mode) — will use direct fetch
      return null;
    }
  }
  return vscodeApi;
}

// Pending request tracking
let requestId = 0;
const pendingRequests = new Map<number, { resolve: (data: any) => void; reject: (err: Error) => void }>();

// Process incoming messages from Extension Host
window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg.type !== "string") return;

  switch (msg.type) {
    case "api:response": {
      const pending = pendingRequests.get(msg.id);
      if (pending) {
        pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.data);
        }
      }
      break;
    }
  }
});

/**
 * Make an API request through the Extension Host bridge.
 * In dev mode (regular browser), falls back to direct fetch.
 */
export async function apiRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: any;
    search?: Record<string, string | number | boolean | undefined>;
  } = {}
): Promise<T> {
  const api = getVsCodeApi();

  // Dev mode fallback — direct fetch
  if (!api) {
    return directFetch<T>(path, options);
  }

  return new Promise<T>((resolve, reject) => {
    const id = ++requestId;
    pendingRequests.set(id, { resolve, reject });
    api.postMessage({
      type: "api:request",
      payload: { id, path, options },
    });

    // Timeout after 30s
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error("请求超时 (30s)"));
      }
    }, 30000);
  });
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Unexpected request error";
}

// --- Dev mode helpers ---

const DEV_API_BASE = "https://bcai.site/api/proxy";

async function directFetch<T>(
  path: string,
  options: { method?: string; body?: any; search?: Record<string, string | number | boolean | undefined> } = {}
): Promise<T> {
  const cleanPath = path.replace(/^\/+/, "");
  let url = `${DEV_API_BASE}/${cleanPath}`;

  if (options.search) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.search)) {
      if (value !== undefined && value !== null && value !== "") {
        params.set(key, String(value));
      }
    }
    const query = params.toString();
    if (query) url += `?${query}`;
  }

  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const resp = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const rawText = await resp.text();
  let payload: any = null;
  if (rawText) {
    try { payload = JSON.parse(rawText); } catch { payload = rawText; }
  }

  if (!resp.ok) {
    let msg = `Request failed (${resp.status})`;
    if (payload && typeof payload === "object" && payload.message) {
      msg = typeof payload.message === "string" ? payload.message : payload.message.join(", ");
    }
    throw new Error(msg);
  }

  return payload as T;
}
