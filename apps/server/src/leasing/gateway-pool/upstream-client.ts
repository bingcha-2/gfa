/**
 * 上游(teamclaude 运营控制面)客户端。
 * 地址和运营 key 由后台配置(运营 key 加密存库),调用方解密后以 UpstreamConfig 传入。
 */
export type UpstreamConfig = { baseUrl: string; opKey: string };

export class UpstreamError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "UpstreamError";
  }
}

export type ProvisionResult = {
  account: string;
  accountId?: string;
  requestId: string;
  replayed: boolean;
  keys: string[];
  clients: string[];
};

const TIMEOUT_MS = 20_000;

async function call(cfg: UpstreamConfig, path: string, init: RequestInit): Promise<any> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), "x-api-key": cfg.opKey },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应 */
  }
  // 上游把工具错误统一放在 error 字符串里,状态码不可靠,两者都要看。
  if (!res.ok || (body && body.ok === false)) {
    const msg = String(body?.error || `HTTP ${res.status}`);
    throw new UpstreamError(msg, res.status);
  }
  return body;
}

/** 开 1 个私有 key。必须带 requestId,超时/失败后用原编号和原参数重试。 */
export async function provisionOneKey(cfg: UpstreamConfig, params: {
  account: string;
  accountId?: string;
  requestId: string;
}): Promise<ProvisionResult> {
  const body = await call(cfg, "/teamclaude/ops/tools/provision_private_keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...params, people: 1 }),
  });
  const r = body?.result;
  if (!r || !Array.isArray(r.keys) || r.keys.length !== 1 || typeof r.keys[0] !== "string") {
    throw new UpstreamError("unexpected provision response shape", 200);
  }
  return r as ProvisionResult;
}

/** 按账号名查询关联 key 的用量(只读,不含 key 明文)。 */
export async function fetchAccountKeyUsage(cfg: UpstreamConfig, account: string): Promise<unknown[]> {
  const q = new URLSearchParams({ account }).toString();
  const body = await call(cfg, `/teamclaude/ops/account-key-usage?${q}`, { method: "GET" });
  if (!Array.isArray(body)) throw new UpstreamError("unexpected usage response shape", 200);
  return body;
}

/** 用母号自己的 key 取该母号支持的模型(GET {baseUrl}/v1/models,Anthropic 格式)。 */
export async function fetchModels(baseUrl: string, key: string): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models`, {
    headers: { authorization: `Bearer ${key}`, "anthropic-version": "2023-06-01" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new UpstreamError(`models HTTP ${res.status}`, res.status);
  const body: any = await res.json();
  const ids: string[] = Array.isArray(body?.data) ? body.data.map((m: any) => String(m?.id || "")).filter(Boolean) : [];
  if (ids.length === 0) throw new UpstreamError("empty model list", 200);
  return ids;
}
