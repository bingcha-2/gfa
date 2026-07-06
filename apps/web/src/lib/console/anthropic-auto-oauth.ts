type AutoOAuthStartErrorInput = {
  ok: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
  rawBody?: string;
};

function stringifyBody(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function compactBody(value: unknown, rawBody?: string): string {
  const body = stringifyBody(value) || String(rawBody || "").trim();
  if (!body) return "";
  return body.length > 240 ? `${body.slice(0, 240)}...` : body;
}

function getBodyError(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" ? error.trim() : "";
}

export function formatAutoOAuthStartError(input: AutoOAuthStartErrorInput): string {
  const bodyError = getBodyError(input.body);
  if (bodyError) return bodyError;

  const summary = compactBody(input.body, input.rawBody);
  if (input.ok) {
    return `启动失败: 启动接口未返回 taskId${summary ? `: ${summary}` : ""}`;
  }

  const status = input.status ? `HTTP ${input.status}${input.statusText ? ` ${input.statusText}` : ""}` : "";
  if (status) return `启动失败 (${status})${summary ? `: ${summary}` : ""}`;
  return `启动失败${summary ? `: ${summary}` : ""}`;
}
