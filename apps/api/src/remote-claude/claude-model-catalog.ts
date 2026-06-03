import { defaultDisplayName, ModelCatalog, ModelInfo } from "../lease-core/model-catalog";

// Claude models bill to the universal "opus" bucket (see UNIVERSAL_BILLING):
// neither gemini nor gpt/codex, so everything Claude falls through to opus.
const CLAUDE_BUCKET = "opus";

// Seed list + display names. Account-level quota is one shared window per
// account, so the exact model set only affects display/validation, not scoring.
const SEED: Record<string, string> = {
  "claude-opus-4-20250514": "Claude Opus 4",
  "claude-opus-4-1-20250805": "Claude Opus 4.1",
  "claude-sonnet-4-20250514": "Claude Sonnet 4",
  "claude-sonnet-4-5-20250929": "Claude Sonnet 4.5",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
  "claude-3-5-haiku-20241022": "Claude Haiku 3.5",
};

// Default upstream model fetch: Anthropic /v1/models with the leased account
// access token. Best-effort; the catalog falls back to the seed on any failure.
async function defaultFetcher(accessToken: string): Promise<string[]> {
  const url = process.env.BCAI_CLAUDE_MODELS_URL || "https://api.anthropic.com/v1/models";
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "anthropic-version": "2023-06-01",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`claude models fetch failed: ${res.status}`);
  const body: any = await res.json();
  const arr = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return arr
    .map((m: any) => String(m?.id || m?.slug || m?.model || m || "").trim())
    .filter(Boolean);
}

export type ClaudeModelCatalogOptions = {
  fetcher?: (accessToken: string) => Promise<string[]>;
};

export class ClaudeModelCatalog implements ModelCatalog {
  private models = new Map<string, ModelInfo>();
  private readonly fetcher: (accessToken: string) => Promise<string[]>;

  constructor(options: ClaudeModelCatalogOptions = {}) {
    this.fetcher = options.fetcher || defaultFetcher;
    for (const [key, displayName] of Object.entries(SEED)) {
      this.models.set(key, { key, displayName, bucket: CLAUDE_BUCKET });
    }
  }

  list(): ModelInfo[] {
    return Array.from(this.models.values());
  }

  classify(_modelKey?: string): string {
    return CLAUDE_BUCKET;
  }

  async refresh(getToken: () => Promise<string>): Promise<void> {
    try {
      const token = await getToken();
      if (!token) return;
      const keys = await this.fetcher(token);
      for (const key of keys) {
        if (!this.models.has(key)) {
          this.models.set(key, { key, displayName: SEED[key] || defaultDisplayName(key), bucket: CLAUDE_BUCKET });
        }
      }
    } catch {
      // Best-effort: keep the seed (and any previously merged) list on failure.
    }
  }
}
