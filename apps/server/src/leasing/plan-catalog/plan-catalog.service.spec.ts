import { describe, expect, it, vi } from "vitest";

import { PlanCatalogService } from "./plan-catalog.service";
import { ACCOUNT_SHARE_CAPACITY } from "../token-server/token-billing";
import {
  DEFAULT_CODEX_RELAY_MODEL_MAP,
  DEFAULT_CODEX_RELAY_MODELS,
} from "../remote-codex/codex-model-defaults";

function makeService(overrides: Record<string, any> = {}) {
  const settingRows = new Map<string, string>(Object.entries(overrides.siteSettings || {}));
  const prisma = {
    planCatalog: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      aggregate: vi.fn().mockResolvedValue({ _max: { version: 0 } }),
      ...overrides.planCatalog,
    },
    siteSetting: {
      findMany: vi.fn(async () => [...settingRows].map(([key, value]) => ({ key, value }))),
      upsert: vi.fn(async ({ where, update, create }: any) => {
        const value = String((settingRows.has(where.key) ? update : create).value);
        settingRows.set(where.key, value);
        return { key: where.key, value };
      }),
    },
    $transaction: vi.fn(async (work: any) => typeof work === "function" ? work(prisma) : Promise.all(work)),
    ...(overrides.subscription ? { subscription: overrides.subscription } : {}),
  };
  const accessKeyStore = overrides.accessKeyStore;
  return { prisma, accessKeyStore, service: new PlanCatalogService(prisma as any, accessKeyStore) };
}

describe("PlanCatalogService Codex relay settings", () => {
  it("uses the bcai NewAPI /v1 endpoint by default and reads the initial key from server env", async () => {
    vi.stubEnv("CODEX_RELAY_API_KEY", "sk-env-only-secret");
    try {
      const { service } = makeService();

      const runtime = await service.resolveCodexRelaySettings();
      const publicSettings = await service.getCodexRelaySettings();

      expect(runtime).toMatchObject({
        enabled: false,
        baseUrl: "https://bcai.online/v1",
        apiKey: "sk-env-only-secret",
        models: [...DEFAULT_CODEX_RELAY_MODELS],
        modelMap: { ...DEFAULT_CODEX_RELAY_MODEL_MAP },
      });
      expect(publicSettings).toMatchObject({
        baseUrl: "https://bcai.online/v1",
        apiKeyConfigured: true,
        apiKeyHint: "****ecret",
      });
      expect(JSON.stringify(publicSettings)).not.toContain("sk-env-only-secret");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("upgrades the initial two-model empty-map defaults to the full GPT catalog", async () => {
    const { service } = makeService({
      siteSettings: {
        codex_relay_models: JSON.stringify(["gpt-5.4", "gpt-5.5"]),
        codex_relay_model_map: JSON.stringify({}),
      },
    });

    const settings = await service.resolveCodexRelaySettings();

    expect(settings.models).toEqual(DEFAULT_CODEX_RELAY_MODELS);
    expect(settings.modelMap).toEqual(DEFAULT_CODEX_RELAY_MODEL_MAP);
    expect(settings.modelMap["gpt-5.6-sol"]).toBe("gpt-5.6-sol");
    expect(settings.modelMap["gpt-5.4-mini"]).toBe("gpt-5.4-mini");
  });

  it("keeps the API key private and only returns a masked hint", async () => {
    const { service } = makeService({
      siteSettings: {
        codex_relay_enabled: "true",
        codex_relay_base_url: "https://bcai.online/v1",
        codex_relay_api_key: "sk-super-secret-value",
        codex_relay_models: JSON.stringify(["gpt-5.4", "gpt-5.5"]),
      },
    });

    const publicSettings = await service.getCodexRelaySettings();

    expect(publicSettings).toMatchObject({
      enabled: true,
      baseUrl: "https://bcai.online/v1",
      apiKeyConfigured: true,
      apiKeyHint: "****value",
      models: ["gpt-5.4", "gpt-5.5"],
    });
    expect(JSON.stringify(publicSettings)).not.toContain("sk-super-secret-value");
  });

  it("empty API key preserves the configured secret", async () => {
    const { service } = makeService({
      siteSettings: { codex_relay_api_key: "sk-existing" },
    });

    await service.updateCodexRelaySettings({
      enabled: true,
      baseUrl: "https://bcai.online",
      apiKey: "",
      models: ["gpt-5.5"],
    });

    expect(await service.resolveCodexRelaySettings()).toMatchObject({
      baseUrl: "https://bcai.online/v1",
      apiKey: "sk-existing",
    });
  });
});

describe("PlanCatalogService.publish", () => {
  it("发布某版 → 该版 PUBLISHED,之前的 PUBLISHED 全部归档为 ARCHIVED(同时至多一个 PUBLISHED)", async () => {
    const { prisma, service } = makeService();

    await service.publish("cat-2");

    // 先把现有 PUBLISHED 归档
    expect(prisma.planCatalog.updateMany).toHaveBeenCalledWith({
      where: { status: "PUBLISHED" },
      data: { status: "ARCHIVED" },
    });
    // 再把目标版设为 PUBLISHED
    expect(prisma.planCatalog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cat-2" },
        data: expect.objectContaining({ status: "PUBLISHED" }),
      }),
    );
  });

  it("发布每份额度后只重算有效订阅，并立即刷新运行时且保留用量窗口", async () => {
    const subscription = {
      id: "sub-1", customerId: "c1", priority: 0, backingKeyValue: "key",
      status: "ACTIVE", expiresAt: null, productEntitlements: JSON.stringify(["codex"]),
      bucketLimits: null, bindings: JSON.stringify({ codex: 1 }),
      levels: JSON.stringify({ codex: "pro" }), weight: 2, deviceLimit: 1,
      weeklyTokenLimit: null, windowMs: 18_000_000,
      config: JSON.stringify({
        line: "bind", products: ["codex"], levels: { codex: "pro" },
        bindings: { codex: 1 }, shareSeats: 2, shareCapacity: 4,
        usdLimit5h: 1, usdLimitWeekly: 2, usdQuotaMigrationVersion: 3,
      }),
    };
    const updateSubscription = vi.fn().mockResolvedValue({});
    const loadSubscriptionRecords = vi.fn();
    const catalog = {
      pricing: { bind: { usdQuotaPerSeat: { codex: { pro: { fiveHour: 5, weekly: 40 } } } } },
    };
    const findSubscriptions = vi.fn().mockResolvedValue([subscription]);
    const { service } = makeService({
      planCatalog: {
        update: vi.fn().mockResolvedValue({
          id: "cat-2", version: 7, status: "PUBLISHED", config: JSON.stringify(catalog),
        }),
      },
      subscription: { findMany: findSubscriptions, update: updateSubscription },
      accessKeyStore: { loadSubscriptionRecords },
    });

    await service.publish("cat-2");

    expect(findSubscriptions).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: "ACTIVE",
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      },
    }));

    const written = JSON.parse(updateSubscription.mock.calls[0][0].data.config);
    expect(written).toMatchObject({
      usdQuotaByProduct: { codex: { fiveHour: 10, weekly: 80 } },
      usdQuotaSource: "catalog",
      usdQuotaCatalogVersion: 7,
      usdQuotaMigrationVersion: 5,
    });
    expect(loadSubscriptionRecords).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "sub-1",
        usdQuotaByProduct: { codex: { fiveHour: 10, weekly: 80 } },
      }),
    ]);
  });
});

describe("PlanCatalogService.createDraft", () => {
  it("创建草稿 → version = 当前最大+1,status=DRAFT,config 原样存", async () => {
    const { prisma, service } = makeService({
      planCatalog: { aggregate: vi.fn().mockResolvedValue({ _max: { version: 3 } }) },
    });

    await service.createDraft('{"durationDays":30}');

    expect(prisma.planCatalog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          version: 4,
          status: "DRAFT",
          config: '{"durationDays":30}',
        }),
      }),
    );
  });

  it("首个草稿 → version = 1", async () => {
    const { prisma, service } = makeService(); // aggregate 默认 _max.version = 0

    await service.createDraft("{}");

    expect(prisma.planCatalog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ version: 1 }) }),
    );
  });
});

describe("PlanCatalogService.getPublished", () => {
  it("返回当前 PUBLISHED 版本,config 解析为对象", async () => {
    const { prisma, service } = makeService({
      planCatalog: {
        findFirst: vi.fn().mockResolvedValue({
          id: "c1",
          version: 2,
          status: "PUBLISHED",
          config: '{"durationDays":30}',
        }),
      },
    });

    const result = await service.getPublished();

    expect(prisma.planCatalog.findFirst).toHaveBeenCalledWith({ where: { status: "PUBLISHED" } });
    expect(result).toEqual(
      expect.objectContaining({ version: 2, config: expect.objectContaining({ durationDays: 30 }) }),
    );
    // 去容量双源:读目录注入运行时 ACCOUNT_SHARE_CAPACITY(test env=4),绑定线 weight 据此算。
    expect((result as any).config.shareCapacity).toBe(ACCOUNT_SHARE_CAPACITY);
  });

  it("没有 PUBLISHED → null", async () => {
    const { service } = makeService();
    expect(await service.getPublished()).toBeNull();
  });
});

describe("PlanCatalogService.getByVersion", () => {
  it("按版本号取该版(config 解析为对象)—— 激活时按订单 catalogVersion 溯源不变的 durationDays", async () => {
    const { prisma, service } = makeService({
      planCatalog: {
        findUnique: vi.fn().mockResolvedValue({
          id: "c1",
          version: 5,
          status: "ARCHIVED",
          config: '{"durationDays":30}',
        }),
      },
    });

    const result = await service.getByVersion(5);

    expect(prisma.planCatalog.findUnique).toHaveBeenCalledWith({ where: { version: 5 } });
    expect(result).toEqual(
      expect.objectContaining({ version: 5, config: expect.objectContaining({ durationDays: 30 }) }),
    );
  });

  it("该版本不存在 → null", async () => {
    const { service } = makeService(); // findUnique 默认 null
    expect(await service.getByVersion(999)).toBeNull();
  });
});
