import { defaultDisplayName, ModelCatalog, ModelInfo } from "../lease-core/model-catalog";
import { isGeminiModel } from "./token-billing";

// Seed list — Gemini (×5 limit bucket) + Claude/Opus (×1 bucket) served via the
// Antigravity IDE. Extended at runtime via observe() with model keys discovered
// from client-reported modelQuota snapshots.
const SEED: Record<string, string> = {
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-3-pro": "Gemini 3 Pro",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-opus-4-6-thinking": "Claude Opus 4.6 Thinking",
};

export class AntigravityModelCatalog implements ModelCatalog {
  private models = new Map<string, ModelInfo>();

  constructor() {
    for (const [key, displayName] of Object.entries(SEED)) {
      this.models.set(key, { key, displayName, bucket: this.classify(key) });
    }
  }

  list(): ModelInfo[] {
    return Array.from(this.models.values());
  }

  classify(modelKey: string): string {
    return isGeminiModel(modelKey) ? "gemini" : "opus";
  }

  /** Antigravity has no standalone upstream model endpoint; discovery happens
   * via observe() from client-reported quota keys. */
  async refresh(): Promise<void> {
    // no-op: see observe()
  }

  /** Merge model keys discovered from client-reported modelQuota snapshots. */
  observe(modelKeys: string[]): void {
    for (const raw of modelKeys) {
      const key = String(raw || "").trim();
      if (!key || this.models.has(key)) continue;
      this.models.set(key, { key, displayName: SEED[key] || defaultDisplayName(key), bucket: this.classify(key) });
    }
  }
}
