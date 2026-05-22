import * as vscode from "vscode";
import { BCAI_CONFIG_SECTION } from "../distribution.js";
import { handleRosettaMessage } from "./rosettaHandler.js";

type IncomingMessage = {
  type: string;
  payload?: any;
};

/**
 * Handles messages from the webview.
 * Acts as a bridge: Webview → Extension Host → GFA API → Webview.
 * Also routes rosetta:* messages to the Rosetta handler.
 */
export async function handleMessage(
  message: IncomingMessage,
  webview: vscode.Webview,
  context: vscode.ExtensionContext
) {
  // Route rosetta messages to dedicated handler
  if (message.type.startsWith("rosetta:")) {
    await handleRosettaMessage(message, webview, context);
    return;
  }

  switch (message.type) {
    case "api:request": {
      const { id, path, options } = message.payload;
      try {
        const result = await proxyApiRequest(path, options, context);
        webview.postMessage({ type: "api:response", id, data: result });
      } catch (err: any) {
        webview.postMessage({ type: "api:response", id, error: err.message ?? String(err) });
      }
      break;
    }
    case "openExternal": {
      const url = message.payload?.url;
      if (url && typeof url === "string") {
        vscode.env.openExternal(vscode.Uri.parse(url));
      }
      break;
    }
  }
}

async function proxyApiRequest(
  path: string,
  options: { method?: string; body?: any; search?: Record<string, string | number | boolean | undefined> } = {},
  context: vscode.ExtensionContext
): Promise<any> {
  const config = vscode.workspace.getConfiguration(BCAI_CONFIG_SECTION);
  const baseUrl = config.get<string>("apiBaseUrl") ?? "https://bcai.site/api/proxy";

  const cleanPath = path.replace(/^\/+/, "");

  let url = `${baseUrl}/${cleanPath}`;

  // Handle query params
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

  return payload;
}
