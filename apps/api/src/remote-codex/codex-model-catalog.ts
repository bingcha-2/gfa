import { defaultDisplayName, ModelCatalog, ModelInfo } from "../lease-core/model-catalog";

const CODEX_BUCKET = "codex";

// Seed list + display names (mirrors cockpit src-tauri/.../codex_protocol.rs).
const SEED: Record<string, string> = {
  "gpt-5-codex": "GPT-5 Codex",
  "gpt-5-codex-mini": "GPT-5 Codex Mini",
  "gpt-5.1-codex-max": "GPT-5.1 Codex Max",
  "gpt-5.1-codex-mini": "GPT-5.1 Codex Mini",
  "gpt-5.2": "GPT-5.2",
  "gpt-5.2-codex": "GPT-5.2 Codex",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.3-codex-spark": "GPT-5.3 Codex Spark",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
};

// Default upstream model fetch: OpenAI/ChatGPT models endpoint with the leased
// account access token. Best-effort; the catalog falls back to the seed on any
// failure. (Endpoint subject to confirmation against the live ChatGPT backend.)
async function defaultFetcher(accessToken: string): Promise<string[]> {
  // Endpoint overridable via env so it can be corrected in prod without a code
  // change (the live ChatGPT backend path/shape is unverified).
  const url = process.env.BCAI_CODEX_MODELS_URL || "https://chatgpt.com/backend-api/models";
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`codex models fetch failed: ${res.status}`);
  const body: any = await res.json();
  const arr = Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : [];
  return arr
    .map((m: any) => String(m?.slug || m?.id || m?.model || m || "").trim())
    .filter(Boolean);
}

export type CodexModelCatalogOptions = {
  fetcher?: (accessToken: string) => Promise<string[]>;
};

export class CodexModelCatalog implements ModelCatalog {
  private models = new Map<string, ModelInfo>();
  private readonly fetcher: (accessToken: string) => Promise<string[]>;

  constructor(options: CodexModelCatalogOptions = {}) {
    this.fetcher = options.fetcher || defaultFetcher;
    for (const [key, displayName] of Object.entries(SEED)) {
      this.models.set(key, { key, displayName, bucket: CODEX_BUCKET });
    }
  }

  list(): ModelInfo[] {
    return Array.from(this.models.values());
  }

  classify(): string {
    return CODEX_BUCKET;
  }

  async refresh(getToken: () => Promise<string>): Promise<void> {
    try {
      const token = await getToken();
      if (!token) return;
      const keys = await this.fetcher(token);
      for (const key of keys) {
        if (!this.models.has(key)) {
          this.models.set(key, { key, displayName: SEED[key] || defaultDisplayName(key), bucket: CODEX_BUCKET });
        }
      }
    } catch {
      // Best-effort: keep the seed (and any previously merged) list on failure.
    }
  }
}
