import { accountUsageRows } from "./account-usage";
import { hasApiPrice } from "@gfa/shared";
import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { nanoid } from "nanoid";

import { PrismaService } from "../../shared/prisma/prisma.service";
import { decryptKey, encryptKey, keyHint } from "./key-vault";
import { fetchAccountUsage, fetchModels, provisionOneKey, UpstreamError, type UpstreamConfig } from "./upstream-client";
import { upstreamWindowTransition } from "./upstream-window";

const MANUAL_REFRESH_MIN_GAP_MS = 10_000;
/** 模型列表定时刷新:基础 6 小时 + [0, 6 小时) 内随机秒数,避免规律性地打上游。 */
const MODELS_REFRESH_BASE_MS = 6 * 3_600_000;
const MODELS_REFRESH_JITTER_SECONDS = 6 * 3_600;

export function nextModelsRefreshDelayMs(random: () => number = Math.random): number {
  return MODELS_REFRESH_BASE_MS + Math.floor(random() * MODELS_REFRESH_JITTER_SECONDS) * 1000;
}
const SETTING_BASE_URL = "gateway_upstream_base_url";
const SETTING_OP_KEY = "gateway_upstream_op_key_cipher";
const DEFAULT_BASE_URL = "https://pool.tk4me.com";

function parseModels(json: string | null | undefined): string[] {
  try {
    const v = json ? JSON.parse(json) : [];
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** 对外(后台接口)可见的字段。刻意不含 keyCipher。 */
function toView(r: any) {
  let usage: unknown = null;
  let accountType: string | null = null;
  try {
    const raw = r.usageJson ? JSON.parse(r.usageJson) : null;
    usage = raw ? accountUsageRows(raw) : null;
    if (raw?.account?.provider === "anthropic") {
      accountType = ({ 1: "Pro", 5: "Max 5x", 20: "Max 20x" } as Record<number, string>)[raw.account.tier?.weight] ?? null;
    }
  } catch {
    usage = null;
  }
  return {
    id: r.id,
    accountName: r.accountName,
    accountType,
    upstreamId: r.upstreamId,
    enabled: r.enabled,
    status: r.status,
    keyHint: r.keyHint,
    hasKey: Boolean(r.keyCipher),
    baseUrl: r.baseUrl,
    totalShares: r.totalShares,
    models: parseModels(r.modelsJson),
    unpricedModels: parseModels(r.modelsJson).filter(id => !hasApiPrice("anthropic", id)),
    modelsSyncedAt: r.modelsSyncedAt,
    lastError: r.lastError,
    usage,
    usageSyncedAt: r.usageSyncedAt,
    lastSyncAt: r.lastSyncAt,
    createdAt: r.createdAt,
  };
}

@Injectable()
export class GatewayPoolService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(GatewayPoolService.name);
  private running: Promise<void> | null = null;
  private lastRunAt = 0;
  private modelsTimer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** 启动时后台补拉过期(超过 6 小时或从未同步)的母号模型列表,之后按 6h+随机 周期全量刷新。 */
  onApplicationBootstrap() {
    void this.refreshAllModels(MODELS_REFRESH_BASE_MS).finally(() => this.scheduleModelsRefresh());
  }

  onModuleDestroy() {
    if (this.modelsTimer) clearTimeout(this.modelsTimer);
    this.modelsTimer = null;
  }

  private scheduleModelsRefresh() {
    const delay = nextModelsRefreshDelayMs();
    this.logger.log(`next models refresh in ${Math.round(delay / 1000)}s`);
    this.modelsTimer = setTimeout(() => {
      void this.refreshAllModels().finally(() => this.scheduleModelsRefresh());
    }, delay);
    this.modelsTimer.unref?.();
  }

  /** 刷新所有启用母号的模型列表;传 staleAfterMs 时只刷新距上次同步超过该时长的母号。 */
  private async refreshAllModels(staleAfterMs?: number) {
    try {
      const rows = await this.prisma.gatewayMotherAccount.findMany({ where: { enabled: true } });
      for (const row of rows) {
        if (!row.keyCipher) continue;
        if (staleAfterMs !== undefined && row.modelsSyncedAt && Date.now() - row.modelsSyncedAt.getTime() < staleAfterMs) continue;
        await this.refreshModels(row.id, true);
      }
    } catch (err) {
      this.logger.warn(`models refresh failed: ${this.safeMessage(err)}`);
    }
  }

  /** 后台展示用:不含运营 key,只告诉前端是否已配置及尾号。 */
  async getSettings() {
    const rows = await this.prisma.siteSetting.findMany({ where: { key: { in: [SETTING_BASE_URL, SETTING_OP_KEY] } } });
    const map = new Map(rows.map((r: any) => [r.key, r.value as string]));
    const cipher = map.get(SETTING_OP_KEY);
    let hint: string | null = null;
    if (cipher) {
      try {
        hint = keyHint(decryptKey(cipher));
      } catch {
        hint = "无法解密";
      }
    }
    return { baseUrl: map.get(SETTING_BASE_URL) || DEFAULT_BASE_URL, hasOpKey: Boolean(cipher), opKeyHint: hint };
  }

  /** opKey 留空表示不修改。运营 key 与母号 key 同样 AES-256-GCM 加密存库。 */
  async saveSettings(input: { baseUrl?: string; opKey?: string }) {
    const baseUrl = String(input?.baseUrl || "").trim();
    if (baseUrl) {
      if (!/^https:\/\/[^\s]+$/i.test(baseUrl)) throw new BadRequestException("上游地址必须是 https:// 开头的地址");
      await this.upsertSetting(SETTING_BASE_URL, baseUrl.replace(/\/+$/, ""));
    }
    const opKey = String(input?.opKey || "").trim();
    if (opKey) await this.upsertSetting(SETTING_OP_KEY, encryptKey(opKey));
    return this.getSettings();
  }

  /** 新母号的默认份数取后台设置 gateway_default_total_shares,没有则用表默认值 6。 */
  private async applyDefaultShares(id: string) {
    const r = await this.prisma.siteSetting.findUnique({ where: { key: "gateway_default_total_shares" } });
    const n = Math.floor(Number(r?.value));
    if (Number.isFinite(n) && n >= 1) {
      await this.prisma.gatewayMotherAccount.update({ where: { id }, data: { totalShares: n } });
    }
  }

  private async upsertSetting(key: string, value: string) {
    await this.prisma.siteSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  }

  private async upstreamConfig(): Promise<UpstreamConfig> {
    const rows = await this.prisma.siteSetting.findMany({ where: { key: { in: [SETTING_BASE_URL, SETTING_OP_KEY] } } });
    const map = new Map(rows.map((r: any) => [r.key, r.value as string]));
    const cipher = map.get(SETTING_OP_KEY);
    if (!cipher) throw new UpstreamError("尚未在后台配置上游运营 Key", 0);
    return { baseUrl: map.get(SETTING_BASE_URL) || DEFAULT_BASE_URL, opKey: decryptKey(cipher) };
  }

  async list() {
    const rows = await this.prisma.gatewayMotherAccount.findMany({ orderBy: { createdAt: "asc" } });
    const sums = await this.prisma.gatewayUser.groupBy({
      by: ["motherAccountId"],
      _sum: { shares: true, usedUsd: true },
      _count: { _all: true },
    });
    const byId = new Map<string, any>(sums.map((x: any) => [x.motherAccountId, x]));
    return rows.map((r: any) => {
      const g = byId.get(r.id);
      return {
        ...toView(r),
        allocatedShares: g?._sum?.shares ?? 0,
        userCount: g?._count?._all ?? 0,
        usersUsedUsd: g?._sum?.usedUsd ?? 0,
      };
    });
  }

  private resetListeners: Array<(motherId: string) => void> = [];

  /** 供用户服务注册:上游窗口重置后,通知其清掉该母号的内存缓存。 */
  onUsersReset(cb: (motherId: string) => void) {
    this.resetListeners.push(cb);
  }

  /** 修改单个母号的调用地址和参考总份数。允许已分配份数超过参考值。 */
  async setConfig(id: string, input: { baseUrl?: string; totalShares?: number }) {
    await this.prisma.$transaction(async (db) => {
      if (!(await db.gatewayMotherAccount.findUnique({ where: { id } }))) throw new NotFoundException("母号不存在");
      const data: Record<string, unknown> = {};
      if (input.baseUrl !== undefined) {
        const b = String(input.baseUrl).trim().replace(/\/+$/, "");
        if (!/^https:\/\/[^\s]+$/i.test(b)) throw new BadRequestException("调用地址必须是 https:// 开头");
        data.baseUrl = b;
      }
      if (input.totalShares !== undefined) {
        const n = Number(input.totalShares);
        if (!Number.isSafeInteger(n) || n < 1 || n > 1000) throw new BadRequestException("份数为 1–1000 的整数");
        data.totalShares = n;
      }
      await db.gatewayMotherAccount.update({ where: { id }, data });
    });
    return (await this.list()).find((x: any) => x.id === id);
  }

  /** 转发用:取母号的调用地址、模型和明文 key。仅转发模块调用,不得经由后台接口返回。 */
  async getForwardTarget(id: string) {
    const row = await this.prisma.gatewayMotherAccount.findUnique({ where: { id } });
    if (!row || !row.enabled || !row.keyCipher || row.status !== "ready") return null;
    return { id: row.id, baseUrl: row.baseUrl, models: parseModels(row.modelsJson), key: decryptKey(row.keyCipher) };
  }

  /** 刷新单个母号的模型列表。托管时调用;10 分钟内刷新过则跳过,减少对上游的请求。 */
  async refreshModels(id: string, force = false): Promise<string[]> {
    const row = await this.mustGet(id);
    if (!row.keyCipher) return parseModels(row.modelsJson);
    if (!force && row.modelsSyncedAt && Date.now() - row.modelsSyncedAt.getTime() < 10 * 60_000) {
      return parseModels(row.modelsJson);
    }
    try {
      const ids = await fetchModels(row.baseUrl, decryptKey(row.keyCipher));
      await this.prisma.gatewayMotherAccount.update({
        where: { id },
        data: { modelsJson: JSON.stringify(ids), modelsSyncedAt: new Date() },
      });
      return ids;
    } catch (err) {
      this.logger.warn(`models ${row.accountName} failed: ${this.safeMessage(err)}`);
      return parseModels(row.modelsJson);
    }
  }

  /** 添加母号:先落库(固定 requestId),再尝试开 key;开 key 失败不丢记录,下次同步用原编号重试。 */
  async add(accountName: string, upstreamId?: string, baseUrl?: string, totalShares?: number) {
    const name = String(accountName || "").trim();
    if (!name || name.length > 200) throw new BadRequestException("accountName 为 1–200 个字符");
    const exists = await this.prisma.gatewayMotherAccount.findUnique({ where: { accountName: name } });
    if (exists) throw new BadRequestException("该母号已存在");

    const row = await this.prisma.gatewayMotherAccount.create({
      data: { accountName: name, upstreamId: upstreamId?.trim() || null, requestId: `gw-${nanoid(24)}` },
    });
    if (baseUrl !== undefined || totalShares !== undefined) await this.setConfig(row.id, { baseUrl, totalShares });
    else await this.applyDefaultShares(row.id);
    await this.ensureKey(row.id);
    await this.refreshModels(row.id, true);
    return toView(await this.mustGet(row.id));
  }

  async remove(id: string) {
    await this.mustGet(id);
    // 只删本地记录和密文。上游已开出的 key 仍在,需在上游把账号转公共池并删除 key(见方案文档)。
    await this.prisma.gatewayMotherAccount.delete({ where: { id } });
  }

  async setEnabled(id: string, enabled: boolean) {
    await this.mustGet(id);
    return toView(await this.prisma.gatewayMotherAccount.update({ where: { id }, data: { enabled } }));
  }

  /**
   * 手动/定时刷新共用。互斥:正在跑则复用同一次结果;10 秒内重复触发直接返回现有数据。
   */
  async refreshAll(manual: boolean) {
    if (this.running) {
      await this.running;
      return this.list();
    }
    if (manual && Date.now() - this.lastRunAt < MANUAL_REFRESH_MIN_GAP_MS) return this.list();
    this.running = this.doRefresh().finally(() => {
      this.running = null;
      this.lastRunAt = Date.now();
    });
    await this.running;
    return this.list();
  }

  @Cron("0 */5 * * * *")
  async scheduledRefresh() {
    try {
      await this.refreshAll(false);
    } catch (err) {
      this.logger.warn(`scheduled refresh failed: ${(err as Error).message}`);
    }
  }

  /**
   * 仅供转发模块调用:取某母号的明文 key。后台接口、日志、错误信息一律不得使用它。
   */
  async getKeyForForwarding(id: string): Promise<string | null> {
    const row = await this.prisma.gatewayMotherAccount.findUnique({ where: { id } });
    if (!row || !row.enabled || !row.keyCipher) return null;
    return decryptKey(row.keyCipher);
  }

  private async doRefresh() {
    const rows = await this.prisma.gatewayMotherAccount.findMany({ where: { enabled: true } });
    for (const row of rows) {
      try {
        if (!row.keyCipher) await this.ensureKey(row.id);
        await this.syncUsage(row.id);
        // 模型列表不在这里拉:由 scheduleModelsRefresh 按 6h+随机 周期刷新,托管时另有按需刷新。
      } catch (err) {
        this.logger.warn(`sync ${row.accountName} failed: ${this.safeMessage(err)}`);
      }
    }
  }

  /** 没有 key 时用固定 requestId 开 key;同一编号重试会返回同一把 key,不会重复发放。 */
  private async ensureKey(id: string) {
    const row = await this.mustGet(id);
    if (row.keyCipher) return;
    try {
      const r = await provisionOneKey(await this.upstreamConfig(), {
        account: row.accountName,
        accountId: row.upstreamId || undefined,
        requestId: row.requestId,
      });
      const plain = r.keys[0];
      await this.prisma.gatewayMotherAccount.update({
        where: { id },
        data: {
          keyCipher: encryptKey(plain),
          keyHint: keyHint(plain),
          upstreamId: row.upstreamId || r.accountId || null,
          status: "ready",
          lastError: null,
        },
      });
    } catch (err) {
      const msg = this.safeMessage(err);
      // 领取窗口过期:key 已发出但我们没存下,无法找回,需要在上游轮换。
      const lost = /private_key_receipt_expired/.test(msg);
      await this.prisma.gatewayMotherAccount.update({
        where: { id },
        data: { status: lost ? "key_lost" : "error", lastError: msg },
      });
    }
  }

  private usageRefreshes = new Map<string, Promise<void>>();
  /** Coalesce read-only usage refreshes across UI polling and request admission. */
  async quotaSnapshot(id: string) {
    const row = await this.mustGet(id);
    const lastAttempt = row.lastSyncAt?.getTime() ?? 0;
    if (row.enabled && row.keyCipher && Date.now() - lastAttempt > 30_000) {
      let pending = this.usageRefreshes.get(id);
      if (!pending) {
        pending = this.syncUsage(id).finally(() => this.usageRefreshes.delete(id));
        this.usageRefreshes.set(id, pending);
      }
      await pending;
      return this.mustGet(id);
    }
    return row;
  }

  private async syncUsage(id: string) {
    const row = await this.mustGet(id);
    const now = new Date();
    try {
      const usage = await fetchAccountUsage(await this.upstreamConfig(), row.accountName);
      const changed = await this.prisma.$transaction(async (tx) => {
        const current = await tx.gatewayMotherAccount.findUniqueOrThrow({ where: { id } });
        const prev = current.upstreamResetAt7d != null ? Number(current.upstreamResetAt7d) : null;
        const transition = upstreamWindowTransition(usage, row.accountName, prev, now.getTime());
        const fiveHour = upstreamWindowTransition(usage, row.accountName, current.upstreamResetAt5h != null ? Number(current.upstreamResetAt5h) : null, now.getTime(), "5h");
        await tx.gatewayMotherAccount.update({
          where: { id },
          data: {
            usageJson: JSON.stringify(usage),
            usageSyncedAt: now,
            lastSyncAt: now,
            lastError: row.status === "key_lost" ? row.lastError : row.keyCipher ? null : row.lastError,
            ...(fiveHour.resetAt !== null ? { upstreamResetAt5h: BigInt(fiveHour.resetAt) } : {}),
            ...(transition.resetAt !== null ? { upstreamResetAt7d: BigInt(transition.resetAt) } : {}),
          },
        });
        if (transition.reset) await tx.gatewayUser.updateMany({
          where: { motherAccountId: id },
          data: { usedUsd: 0, periodStartedAt: now },
        });
        return transition.reset;
      });
      if (changed) {
        this.logger.log(`upstream 7d window reset detected for ${row.accountName}; users reset`);
        for (const cb of this.resetListeners) cb(id);
      }
    } catch (err) {
      await this.prisma.gatewayMotherAccount.update({
        where: { id },
        data: { lastSyncAt: now, lastError: this.safeMessage(err) },
      });
    }
  }

  private async mustGet(id: string) {
    const row = await this.prisma.gatewayMotherAccount.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("母号不存在");
    return row;
  }

  /** 错误信息只取上游的 error 字符串,截断,避免任何意外内容进库或日志。 */
  private safeMessage(err: unknown): string {
    const m = err instanceof UpstreamError ? err.message : (err as Error)?.message || "unknown error";
    return m.replace(/tc-[A-Za-z0-9_-]{8,}/g, "tc-****").slice(0, 300);
  }
}
