import { Controller, Get, Injectable, Logger, Module, OnModuleInit } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { createHash } from "node:crypto";
import { getApiPriceSnapshots, installApiPriceSnapshots, modelsDevRegistry, type ApiPriceRegistry } from "@gfa/shared";
import { PrismaService } from "../prisma/prisma.service";
import { PrismaModule } from "../prisma/prisma.module";
import { Public } from "../auth/public.decorator";

const KEY = "automatic_model_pricing_v1";
const SIX_HOURS = 6 * 60 * 60_000;
// Shared by admission paths, with one fetch at a time and a five-minute miss cooldown.
let refresh: (() => Promise<void>) | undefined;
export async function refreshModelPricing() { await refresh?.(); }

@Injectable()
export class PricingService implements OnModuleInit {
  private readonly logger = new Logger(PricingService.name);
  private pending?: Promise<void>;
  private lastAttempt = 0;
  private syncedAt = 0;
  constructor(private readonly prisma: PrismaService) {}
  async onModuleInit() {
    const row = await this.prisma.siteSetting.findUnique({ where: { key: KEY } });
    if (row) {
      const saved = JSON.parse(row.value);
      installApiPriceSnapshots(saved.snapshots);
      this.syncedAt = saved.syncedAt || 0;
    }
    refresh = () => this.sync(true);
    await this.sync();
  }
  @Interval(SIX_HOURS)
  async scheduledSync() { await this.sync(); }
  async sync(force = false): Promise<void> {
    if (this.pending) return this.pending;
    if (Date.now() - this.lastAttempt < 5 * 60_000 || (!force && Date.now() - this.syncedAt < SIX_HOURS)) return;
    this.lastAttempt = Date.now();
    this.pending = this.fetchAndSave().catch(error => {
      this.logger.warn(`Price sync failed; retaining last valid snapshot: ${String(error?.message || error)}`);
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async fetchAndSave() {
    const response = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`);
    const raw = await response.text();
    if (raw.length > 20_000_000) throw new Error("Price catalog too large");
    const at = Date.now();
    const parsed = modelsDevRegistry(JSON.parse(raw), "", at);
    // Ignore descriptions and catalog ordering: only price changes create a version.
    const fingerprint = parsed.models.map(m => ({...m, effectiveFrom: ""})).sort((a,b) => `${a.provider}/${a.canonicalModelId}`.localeCompare(`${b.provider}/${b.canonicalModelId}`));
    parsed.version = `models.dev-${createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex").slice(0, 16)}`;
    const previous = getApiPriceSnapshots();
    const snapshots: ApiPriceRegistry[] = previous.at(-1)?.version === parsed.version ? previous : [...previous, parsed];
    await this.prisma.siteSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify({ syncedAt: at, snapshots }) }, update: { value: JSON.stringify({ syncedAt: at, snapshots }) } });
    installApiPriceSnapshots(snapshots);
    this.syncedAt = at;
    this.logger.log(`Model prices synchronized: ${parsed.models.length} models, ${parsed.version}`);
  }
}
@Public()
@Controller("pricing")
export class PricingController {
  @Get("snapshot")
  snapshot() { return { snapshots: getApiPriceSnapshots() }; }
}
@Module({ imports: [PrismaModule], providers: [PricingService], controllers: [PricingController] })
export class PricingModule {}
