import { beforeEach, afterEach } from "vitest";
import { apiPriceRegistryAt, installApiPriceSnapshots, type ApiPriceModel, type ApiPricingProvider } from "@gfa/shared";

// Transport/quota suites use synthetic provider/model combinations. Supply a
// deterministic catalog for those fixtures without bypassing pricing admission
// or depending on a live models.dev sync. Pricing suites test real catalogs.
const bundled = apiPriceRegistryAt(0);
const fixtures: ApiPriceModel[] = [];
for (const provider of ["anthropic", "antigravity", "codex"] as ApiPricingProvider[]) {
  for (const id of ["gemini", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-3-flash", "gemini-2.5-flash-lite", "claude", "claude-opus-4-20250514"]) {
    fixtures.push({ provider, canonicalModelId: id, aliases: [], effectiveFrom: "1970-01-01T00:00:00Z",
      modes: { standard: { short: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 } } } });
  }
}
beforeEach(() => installApiPriceSnapshots([{ version: "lease-test-fixture", effectiveAt: 0, models: [...bundled.models, ...fixtures] }]));
afterEach(() => installApiPriceSnapshots([]));
