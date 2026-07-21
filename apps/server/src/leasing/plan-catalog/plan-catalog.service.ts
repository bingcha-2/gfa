import { Inject, Injectable, Logger, Optional } from "@nestjs/common";

import { PrismaService } from "../../shared/prisma/prisma.service";
import { ACCOUNT_SHARE_CAPACITY } from "../token-server/token-billing";
import { AccessKeyStore } from "../token-server/access-key-store";
import { rowToConfig, subscriptionToLimitRecord } from "../subscription/subscription-config";
import { migrateBindSubscriptionToUsd } from "../subscription/subscription-usd-migration";
import {
  DEFAULT_CODEX_RELAY_MODEL_MAP,
  DEFAULT_CODEX_RELAY_MODELS,
} from "../remote-codex/codex-model-defaults";
import type { CatalogConfig } from "./pricing";

const CODEX_RELAY_SETTING_KEYS = {
  enabled: "codex_relay_enabled",
  baseUrl: "codex_relay_base_url",
  apiKey: "codex_relay_api_key",
  models: "codex_relay_models",
  modelMap: "codex_relay_model_map",
} as const;

const DEFAULT_CODEX_RELAY_BASE_URL = "https://bcai.online/v1";

export type CodexRelaySettings = {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  models: string[];
  modelMap: Record<string, string>;
};

/**
 * PlanCatalog 生命周期:草稿编辑 → 发布(同时至多一条 PUBLISHED)。
 * config 为 JSON 字符串(SQLite 无 Json 类型)。见 spec §4.1 / §7。
 */
@Injectable()
export class PlanCatalogService {
  private readonly logger = new Logger(PlanCatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject("SHARED_ACCESS_KEY_STORE") private readonly accessKeyStore?: AccessKeyStore,
  ) {}

  /** Private runtime configuration for the Codex NewAPI relay. The API key is
   * intentionally kept outside PlanCatalog.config because the published catalog
   * is public. Callers must never serialize resolveCodexRelaySettings() directly
   * into a customer-facing response. */
  async resolveCodexRelaySettings(): Promise<CodexRelaySettings> {
    const keys = Object.values(CODEX_RELAY_SETTING_KEYS);
    const rows = await this.prisma.siteSetting.findMany({ where: { key: { in: keys } } });
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const models = parseRelayModels(values.get(CODEX_RELAY_SETTING_KEYS.models));
    const modelMap = parseRelayModelMap(values.get(CODEX_RELAY_SETTING_KEYS.modelMap));
    const hasLegacyDefaults = isLegacyRelayDefaults(models, modelMap);
    return {
      enabled: values.get(CODEX_RELAY_SETTING_KEYS.enabled) === "true",
      // NewAPI's OpenAI-compatible endpoint lives under /v1. Keep a usable
      // first-run URL while allowing production to override it without a code
      // change. Secrets remain server-side and are never hardcoded here.
      baseUrl: normalizeRelayBaseUrl(
        values.get(CODEX_RELAY_SETTING_KEYS.baseUrl)
        || process.env.CODEX_RELAY_BASE_URL
        || DEFAULT_CODEX_RELAY_BASE_URL,
      ),
      apiKey: String(
        values.get(CODEX_RELAY_SETTING_KEYS.apiKey)
        || process.env.CODEX_RELAY_API_KEY
        || "",
      ).trim(),
      models: hasLegacyDefaults ? defaultRelayModels() : models,
      modelMap: hasLegacyDefaults ? defaultRelayModelMap() : modelMap,
    };
  }

  async getCodexRelaySettings() {
    const settings = await this.resolveCodexRelaySettings();
    return {
      enabled: settings.enabled,
      baseUrl: settings.baseUrl,
      apiKeyConfigured: settings.apiKey !== "",
      apiKeyHint: maskRelayApiKey(settings.apiKey),
      models: settings.models,
      modelMap: settings.modelMap,
    };
  }

  async updateCodexRelaySettings(input: {
    enabled?: boolean;
    baseUrl?: string;
    apiKey?: string;
    models?: unknown;
    modelMap?: unknown;
  }) {
    const current = await this.resolveCodexRelaySettings();
    const enabled = input.enabled === true;
    const baseUrl = normalizeRelayBaseUrl(input.baseUrl ?? current.baseUrl);
    // Empty key means "keep the configured secret" so the masked console form
    // never needs to receive or echo the full credential.
    const apiKey = String(input.apiKey || "").trim() || current.apiKey;
    const models = normalizeRelayModels(input.models ?? current.models);
    const modelMap = normalizeRelayModelMap(input.modelMap ?? current.modelMap);
    if (enabled && (!baseUrl || !apiKey)) {
      throw new Error("开启 Codex 中转前必须配置 Base URL 和 API Key");
    }
    const values: Record<string, string> = {
      [CODEX_RELAY_SETTING_KEYS.enabled]: enabled ? "true" : "false",
      [CODEX_RELAY_SETTING_KEYS.baseUrl]: baseUrl,
      [CODEX_RELAY_SETTING_KEYS.apiKey]: apiKey,
      [CODEX_RELAY_SETTING_KEYS.models]: JSON.stringify(models),
      [CODEX_RELAY_SETTING_KEYS.modelMap]: JSON.stringify(modelMap),
    };
    await this.prisma.$transaction(Object.entries(values).map(([key, value]) =>
      this.prisma.siteSetting.upsert({ where: { key }, update: { value }, create: { key, value } }),
    ));
    return this.getCodexRelaySettings();
  }

  /** 发布某版本:先把现有 PUBLISHED 归档,再把目标版设为 PUBLISHED。 */
  async publish(id: string) {
    const apply = async (db: any) => {
      await db.planCatalog.updateMany({
        where: { status: "PUBLISHED" },
        data: { status: "ARCHIVED" },
      });
      const published = await db.planCatalog.update({
        where: { id },
        data: { status: "PUBLISHED", publishedAt: new Date() },
      });
      const refresh = await this.rewriteSubscriptionUsdQuotas(db, published);
      return { published, ...refresh };
    };
    const result = typeof (this.prisma as any).$transaction === "function"
      ? await (this.prisma as any).$transaction((tx: any) => apply(tx))
      : await apply(this.prisma);
    // Runtime state changes only after the catalog + every subscription config
    // committed together. A failed transaction therefore cannot expose a
    // partially-published quota rule to active sessions.
    for (const record of result.activeRecords) {
      this.accessKeyStore?.loadSubscriptionRecords([record]);
    }
    if (result.changed > 0) {
      this.logger.log(`published per-share USD quotas applied to ${result.changed} subscription(s)`);
    }
    return result.published;
  }

  /** 新建草稿版本:version = 现有最大 + 1。 */
  async createDraft(config: string) {
    const max = await this.prisma.planCatalog.aggregate({ _max: { version: true } });
    const nextVersion = (max._max.version ?? 0) + 1;
    return this.prisma.planCatalog.create({
      data: { version: nextVersion, status: "DRAFT", config },
    });
  }

  /** 当前发布版本(config 解析为对象);无则 null。 */
  async getPublished() {
    const row = await this.prisma.planCatalog.findFirst({ where: { status: "PUBLISHED" } });
    if (!row) return null;
    return { ...row, config: this.withRuntimeCapacity(JSON.parse(row.config)) };
  }

  /**
   * 按版本号取目录(config 解析为对象);无则 null。版本一经创建其 config 不再变更
   * (改价=发新版),故激活时按订单的 catalogVersion 溯源稳定的 durationDays 等全局规则。
   */
  async getByVersion(version: number) {
    const row = await this.prisma.planCatalog.findUnique({ where: { version } });
    if (!row) return null;
    return { ...row, config: this.withRuntimeCapacity(JSON.parse(row.config)) };
  }

  /**
   * 读目录时注入运行时账号份额容量(ACCOUNT_SHARE_CAPACITY)——绑定线 weight=容量/共享人数
   * 必须与运行时座位口径同源(去双源:定价不再硬编码 8)。按当前 env 注入、不落库,故改 env
   * 后无陈旧快照;已显式带 shareCapacity 的 config 保留其值(测试/特例可覆盖)。
   */
  private withRuntimeCapacity(config: any) {
    if (config && typeof config === "object" && config.shareCapacity == null) {
      config.shareCapacity = ACCOUNT_SHARE_CAPACITY;
    }
    return config;
  }

  /**
   * A published per-share quota is a live plan rule, not a new-customer-only
   * snapshot. Rewrite currently active, unexpired Codex/Claude bind subscriptions
   * without touching their used USD windows. Inactive history remains immutable;
   * entitlement-sync migrates it if it is ever renewed.
   */
  private async rewriteSubscriptionUsdQuotas(
    db: any,
    published: { config?: string; version?: number },
  ): Promise<{ changed: number; activeRecords: any[] }> {
    if (!published?.config || !db.subscription?.findMany) return { changed: 0, activeRecords: [] };
    const catalog = this.withRuntimeCapacity(JSON.parse(published.config)) as CatalogConfig;
    const now = new Date();
    const rows = await db.subscription.findMany({
      where: { status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: {
        id: true, customerId: true, priority: true, backingKeyValue: true,
        status: true, expiresAt: true, productEntitlements: true,
        bucketLimits: true, bindings: true, levels: true, weight: true,
        deviceLimit: true, weeklyTokenLimit: true, windowMs: true, config: true,
      },
    });
    let changed = 0;
    const activeRecords: any[] = [];
    for (const sub of rows) {
      const migration = migrateBindSubscriptionToUsd(rowToConfig(sub as any), catalog, {
        forceCatalogRefresh: true,
        catalogVersion: published.version,
      });
      if (!migration.changed) continue;
      const serialized = JSON.stringify(migration.config);
      await db.subscription.update({ where: { id: sub.id }, data: { config: serialized } });
      changed++;

      activeRecords.push(subscriptionToLimitRecord({
            id: sub.id,
            customerId: sub.customerId,
            priority: sub.priority,
            backingKeyValue: sub.backingKeyValue,
            status: sub.status,
            expiresAt: sub.expiresAt,
            config: migration.config,
          }) as any);
    }
    return { changed, activeRecords };
  }
}

function normalizeRelayBaseUrl(value: unknown): string {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Codex 中转 Base URL 格式不正确");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Codex 中转 Base URL 仅支持 HTTP/HTTPS");
  }
  // NewAPI channel connection exports commonly contain only the site root.
  // Our desktop proxy appends `/responses`, so normalize a root URL to the
  // OpenAI-compatible API base first and avoid accidentally calling `/responses`.
  if (parsed.pathname === "/" || parsed.pathname === "") parsed.pathname = "/v1";
  return parsed.toString().replace(/\/$/, "");
}

function normalizeRelayModels(value: unknown): string[] {
  const source = Array.isArray(value) ? value : [];
  return [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))];
}

function parseRelayModels(value: string | undefined): string[] {
  if (!value) return defaultRelayModels();
  try {
    const parsed = normalizeRelayModels(JSON.parse(value));
    return parsed.length > 0 ? parsed : defaultRelayModels();
  } catch {
    return defaultRelayModels();
  }
}

function normalizeRelayModelMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([from, to]) => [from.trim(), String(to || "").trim()] as const)
    .filter(([from, to]) => Boolean(from && to)));
}

function parseRelayModelMap(value: string | undefined): Record<string, string> {
  if (!value) return defaultRelayModelMap();
  try {
    return normalizeRelayModelMap(JSON.parse(value));
  } catch {
    return defaultRelayModelMap();
  }
}

function defaultRelayModels(): string[] {
  return [...DEFAULT_CODEX_RELAY_MODELS];
}

function defaultRelayModelMap(): Record<string, string> {
  return { ...DEFAULT_CODEX_RELAY_MODEL_MAP };
}

/** Upgrade the short-lived first release which persisted only two models and
 * an empty map. Once the expanded values are saved, deliberately clearing a
 * custom map remains possible because the model list no longer matches this
 * legacy signature. */
function isLegacyRelayDefaults(models: string[], modelMap: Record<string, string>): boolean {
  return models.length === 2
    && models[0] === "gpt-5.4"
    && models[1] === "gpt-5.5"
    && Object.keys(modelMap).length === 0;
}

function maskRelayApiKey(value: string): string {
  if (!value) return "";
  return `****${value.slice(-5)}`;
}
