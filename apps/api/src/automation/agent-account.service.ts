/**
 * AgentAccountService — manages child/proxy account lifecycle.
 *
 * States: REGISTERED → PHONE_VERIFIED → IN_GROUP → UPLOADED → REMOVED
 *
 * Credentials are stored in the AgentAccount table (separate from Account/母号).
 * Token capture happens automatically when phone-verify/OAuth tasks complete.
 */

import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import {
  QUEUE_NAMES,
  TASK_TYPES,
  JOB_DEFAULTS,
  type AutomationPayload,
  type PhoneInfo,
} from "@gfa/shared";

interface ImportLine {
  loginEmail: string;
  loginPassword: string;
  totpSecret?: string;
  recoveryEmail?: string;
}

@Injectable()
export class AgentAccountService {
  private readonly logger = new Logger(AgentAccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.automation)
    private readonly automationQueue: Queue,
  ) {}

  // ── List / Stats ──

  async findAll(filters?: {
    status?: string;
    pool?: string;
    banned?: string;
    page?: number;
    pageSize?: number;
  }) {
    const where: any = {};
    if (filters?.status && filters.status !== 'all') where.status = filters.status;
    if (filters?.pool) where.pool = filters.pool;
    if (filters?.banned === 'true') where.banned = true;
    if (filters?.banned === 'false') where.banned = false;

    const page = Math.max(1, filters?.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filters?.pageSize ?? 20));
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      this.prisma.agentAccount.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      this.prisma.agentAccount.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getStats() {
    const [total, registered, phoneVerified, inGroup, uploaded, removed,
           pending, noBan, noBanActive, noBanBanned, banRisk, banRiskActive, banRiskBanned] =
      await Promise.all([
        this.prisma.agentAccount.count(),
        this.prisma.agentAccount.count({ where: { status: "REGISTERED" } }),
        this.prisma.agentAccount.count({ where: { status: "PHONE_VERIFIED" } }),
        this.prisma.agentAccount.count({ where: { status: "IN_GROUP" } }),
        this.prisma.agentAccount.count({ where: { status: "UPLOADED" } }),
        this.prisma.agentAccount.count({ where: { status: "REMOVED" } }),
        this.prisma.agentAccount.count({ where: { pool: "pending" } }),
        this.prisma.agentAccount.count({ where: { pool: "no_ban" } }),
        this.prisma.agentAccount.count({ where: { pool: "no_ban", banned: false } }),
        this.prisma.agentAccount.count({ where: { pool: "no_ban", banned: true } }),
        this.prisma.agentAccount.count({ where: { pool: "ban_risk" } }),
        this.prisma.agentAccount.count({ where: { pool: "ban_risk", banned: false } }),
        this.prisma.agentAccount.count({ where: { pool: "ban_risk", banned: true } }),
      ]);
    return {
      total, registered, phoneVerified, inGroup, uploaded, removed,
      pools: {
        pending,
        noBan, noBanActive, noBanBanned,
        banRisk, banRiskActive, banRiskBanned,
      },
    };
  }

  // ── Import ──

  /**
   * Bulk import child account credentials.
   * Same format as bulk account import:
   *   email---password---totpSecret
   *   email——password——totpSecret
   *   email|password|totpSecret
   */
  async bulkImport(rawLines: string[]) {
    const lines = rawLines.map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

    const created: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    const parsed: ImportLine[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let email: string;
      let password: string;
      let totpSecret: string | undefined;
      let recoveryEmail: string | undefined;

      if (line.includes("---")) {
        const parts = line.split(/-{3,}/).map((p) => p.trim());
        if (parts.length < 2) {
          errors.push(`Line ${i + 1}: 格式错误，至少需要 邮箱---密码`);
          continue;
        }
        email = parts[0];
        password = parts[1];
        for (const field of parts.slice(2).filter(Boolean)) {
          if (field.includes("@") && !recoveryEmail) {
            recoveryEmail = field;
          } else if (!totpSecret) {
            totpSecret = this.extractTotp(field);
          }
        }
      } else if (line.includes("——")) {
        const parts = line.split("——").map((p) => p.trim());
        if (parts.length < 2) {
          errors.push(`Line ${i + 1}: 格式错误，至少需要 邮箱——密码`);
          continue;
        }
        email = parts[0];
        password = parts[1];
        if (parts[2]) totpSecret = this.extractTotp(parts[2]);
      } else if (line.includes("|")) {
        const parts = line.split("|").map((p) => p.trim());
        if (parts.length < 2) {
          errors.push(`Line ${i + 1}: 格式错误，至少需要 邮箱|密码`);
          continue;
        }
        email = parts[0];
        password = parts[1];
        if (parts[2]) totpSecret = this.extractTotp(parts[2]);
      } else {
        errors.push(`Line ${i + 1}: 格式错误，请使用 ---、——或 | 分隔符`);
        continue;
      }

      if (!email.includes("@")) {
        errors.push(`Line ${i + 1}: 无效邮箱 "${email}"`);
        continue;
      }
      if (!password.trim()) {
        errors.push(`Line ${i + 1}: 密码不能为空`);
        continue;
      }

      parsed.push({ loginEmail: email, loginPassword: password, totpSecret, recoveryEmail });
    }

    // Batch-check existing
    const candidateEmails = parsed.map((p) => p.loginEmail);
    const existing = await this.prisma.agentAccount.findMany({
      where: { loginEmail: { in: candidateEmails } },
      select: { loginEmail: true },
    });
    const existingSet = new Set(existing.map((a) => a.loginEmail.toLowerCase()));

    for (const item of parsed) {
      if (existingSet.has(item.loginEmail.toLowerCase())) {
        skipped.push(item.loginEmail);
        continue;
      }

      try {
        await this.prisma.agentAccount.create({
          data: {
            loginEmail: item.loginEmail,
            loginPassword: item.loginPassword,
            totpSecret: item.totpSecret,
            recoveryEmail: item.recoveryEmail,
            status: "REGISTERED",
          },
        });
        created.push(item.loginEmail);
      } catch (err: any) {
        if (err?.code === "P2002") {
          skipped.push(item.loginEmail);
        } else {
          errors.push(`${item.loginEmail}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return {
      total: lines.length,
      created: created.length,
      skipped: skipped.length,
      errorCount: errors.length,
      createdEmails: created,
      skippedEmails: skipped,
      errors,
    };
  }

  // ── CRUD ──

  async update(id: string, data: { loginPassword?: string; totpSecret?: string; recoveryEmail?: string; notes?: string }) {
    const account = await this.prisma.agentAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundException("AgentAccount not found");

    return this.prisma.agentAccount.update({
      where: { id },
      data: {
        ...(data.loginPassword !== undefined && { loginPassword: data.loginPassword }),
        ...(data.totpSecret !== undefined && { totpSecret: data.totpSecret }),
        ...(data.recoveryEmail !== undefined && { recoveryEmail: data.recoveryEmail }),
        ...(data.notes !== undefined && { notes: data.notes }),
      },
    });
  }

  async delete(id: string) {
    const account = await this.prisma.agentAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundException("AgentAccount not found");
    await this.prisma.agentAccount.delete({ where: { id } });
    return { deleted: true, loginEmail: account.loginEmail };
  }

  // ── Actions ──

  /**
   * Trigger phone-verify for an agent account.
   * Creates PHONE_VERIFY task via BullMQ → Worker → OAuth + phone verify.
   */
  async triggerPhoneVerify(id: string) {
    const account = await this.prisma.agentAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundException("AgentAccount not found");

    // Get available phones
    const phones = await this.prisma.phonePool.findMany({
      where: { status: "available" },
      orderBy: { usedCount: "asc" },
      take: 5,
      select: { phoneNumber: true, countryCode: true, smsUrl: true },
    });

    const payload: AutomationPayload = {
      action: "phone-verify",
      credentials: {
        email: account.loginEmail,
        password: account.loginPassword,
        totpSecret: account.totpSecret ?? undefined,
      },
      phones: phones.length > 0 ? phones : undefined,
    };

    const task = await this.prisma.task.create({
      data: {
        type: TASK_TYPES.phoneVerify as any,
        status: "PENDING",
        source: "agent-account",
        payload: JSON.stringify({ action: "phone-verify", email: account.loginEmail }),
      },
    });

    await this.automationQueue.add("phone-verify", { ...payload, taskId: task.id }, {
      ...JOB_DEFAULTS,
      jobId: `automation-${task.id}`,
    });

    await this.prisma.agentAccount.update({
      where: { id },
      data: { lastTaskId: task.id },
    });

    return { taskId: task.id, email: account.loginEmail, status: "PENDING" };
  }

  /**
   * Trigger OAuth for an agent account (to get refresh_token without phone verify).
   */
  async triggerOAuth(id: string) {
    const account = await this.prisma.agentAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundException("AgentAccount not found");

    const payload: AutomationPayload = {
      action: "oauth",
      credentials: {
        email: account.loginEmail,
        password: account.loginPassword,
        totpSecret: account.totpSecret ?? undefined,
      },
    };

    const task = await this.prisma.task.create({
      data: {
        type: TASK_TYPES.oauthAuthorize as any,
        status: "PENDING",
        source: "agent-account",
        payload: JSON.stringify({ action: "oauth", email: account.loginEmail }),
      },
    });

    await this.automationQueue.add("oauth", { ...payload, taskId: task.id }, {
      ...JOB_DEFAULTS,
      jobId: `automation-${task.id}`,
    });

    await this.prisma.agentAccount.update({
      where: { id },
      data: { lastTaskId: task.id },
    });

    return { taskId: task.id, email: account.loginEmail, status: "PENDING" };
  }

  /**
   * Trigger accept-invite for an agent account.
   */
  async triggerAcceptInvite(id: string) {
    const account = await this.prisma.agentAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundException("AgentAccount not found");

    // Get available phones for proactive phone verify
    const phones = await this.prisma.phonePool.findMany({
      where: { status: "available" },
      orderBy: { usedCount: "asc" },
      take: 5,
      select: { phoneNumber: true, countryCode: true, smsUrl: true },
    });

    const payload: AutomationPayload = {
      action: "accept-invite",
      credentials: {
        email: account.loginEmail,
        password: account.loginPassword,
        totpSecret: account.totpSecret ?? undefined,
      },
      phones: phones.length > 0 ? phones : undefined,
    };

    const task = await this.prisma.task.create({
      data: {
        type: TASK_TYPES.acceptInvite as any,
        status: "PENDING",
        source: "agent-account",
        payload: JSON.stringify({ action: "accept-invite", email: account.loginEmail }),
      },
    });

    await this.automationQueue.add("accept-invite", { ...payload, taskId: task.id }, {
      ...JOB_DEFAULTS,
      jobId: `automation-${task.id}`,
    });

    await this.prisma.agentAccount.update({
      where: { id },
      data: { lastTaskId: task.id },
    });

    return { taskId: task.id, email: account.loginEmail, status: "PENDING" };
  }

  /**
   * Batch action: trigger a specific action for multiple accounts.
   */
  async batchAction(ids: string[], action: "phone-verify" | "oauth" | "accept-invite") {
    const results: Array<{ id: string; email: string; taskId?: string; error?: string }> = [];
    for (const id of ids) {
      try {
        let result;
        switch (action) {
          case "phone-verify":
            result = await this.triggerPhoneVerify(id);
            break;
          case "oauth":
            result = await this.triggerOAuth(id);
            break;
          case "accept-invite":
            result = await this.triggerAcceptInvite(id);
            break;
        }
        results.push({ id, email: result.email, taskId: result.taskId });
      } catch (err) {
        results.push({ id, email: "", error: err instanceof Error ? err.message : String(err) });
      }
    }
    return {
      total: ids.length,
      queued: results.filter((r) => r.taskId).length,
      failed: results.filter((r) => r.error).length,
      results,
    };
  }

  // ── Status update hooks (called by worker/controller) ──

  /**
   * Called after OAuth/phone-verify task succeeds.
   * Auto-captures refresh_token and updates status.
   */
  async onTokenObtained(email: string, refreshToken: string) {
    const account = await this.prisma.agentAccount.findUnique({
      where: { loginEmail: email },
    });
    if (!account) return; // Not an agent account — ignore

    // Only advance status if currently REGISTERED
    const newStatus = account.status === "REGISTERED" ? "PHONE_VERIFIED" : account.status;

    await this.prisma.agentAccount.update({
      where: { loginEmail: email },
      data: {
        refreshToken,
        tokenObtainedAt: new Date(),
        status: newStatus as any,
      },
    });

    this.logger.log(`Token captured for agent account ${email}, status → ${newStatus}`);
  }

  /**
   * Called after accept-invite task succeeds.
   */
  async onJoinedGroup(email: string, familyGroupId?: string) {
    const account = await this.prisma.agentAccount.findUnique({
      where: { loginEmail: email },
    });
    if (!account) return;

    await this.prisma.agentAccount.update({
      where: { loginEmail: email },
      data: {
        status: "IN_GROUP",
        familyGroupId: familyGroupId ?? account.familyGroupId,
      },
    });

    this.logger.log(`Agent account ${email} joined group, status → IN_GROUP`);
  }

  /**
   * Called after CLIProxy upload succeeds.
   */
  async onUploaded(email: string) {
    const account = await this.prisma.agentAccount.findUnique({
      where: { loginEmail: email },
    });
    if (!account) return;

    await this.prisma.agentAccount.update({
      where: { loginEmail: email },
      data: {
        status: "UPLOADED",
        uploadedAt: new Date(),
      },
    });
  }

  /**
   * Called after CLIProxy delete.
   */
  async onRemoved(email: string) {
    const account = await this.prisma.agentAccount.findUnique({
      where: { loginEmail: email },
    });
    if (!account) return;

    await this.prisma.agentAccount.update({
      where: { loginEmail: email },
      data: {
        status: "REMOVED",
        removedAt: new Date(),
      },
    });
  }

  // ── Token extraction from completed tasks ──

  /**
   * Retroactively extract refresh_token from a completed phone-verify/OAuth task.
   * Used when the auto-capture didn't fire (e.g. older tasks before the fix).
   */
  async extractTokenFromTask(agentAccountId: string) {
    const account = await this.prisma.agentAccount.findUnique({ where: { id: agentAccountId } });
    if (!account) throw new NotFoundException("AgentAccount not found");

    // Find the most recent SUCCESS task for this email
    const recentTasks = await this.prisma.task.findMany({
      where: {
        status: "SUCCESS",
        type: { in: ["PHONE_VERIFY", "OAUTH_AUTHORIZE"] },
        payload: { contains: account.loginEmail },
      },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { id: true, payload: true, type: true, updatedAt: true },
    });

    if (recentTasks.length === 0) {
      throw new BadRequestException(
        `没有找到 ${account.loginEmail} 的成功验证任务。请先运行手机验证或OAuth。`
      );
    }

    // Try to extract refresh_token from each task's payload
    for (const task of recentTasks) {
      try {
        const payload = JSON.parse(task.payload ?? "{}");
        const refreshToken = payload?.token?.refresh_token
          ?? payload?.result?.refresh_token;

        if (refreshToken && typeof refreshToken === "string") {
          const newStatus = account.status === "REGISTERED" ? "PHONE_VERIFIED" : account.status;
          await this.prisma.agentAccount.update({
            where: { id: agentAccountId },
            data: {
              refreshToken,
              tokenObtainedAt: new Date(),
              status: newStatus as any,
              lastTaskId: task.id,
            },
          });

          this.logger.log(
            `Token extracted from task ${task.id} for ${account.loginEmail}, status → ${newStatus}`
          );

          return {
            success: true,
            email: account.loginEmail,
            status: newStatus,
            taskId: task.id,
            message: `已从任务 ${task.id.slice(-6)} 提取Token并保存`,
          };
        }
      } catch {
        continue;
      }
    }

    throw new BadRequestException(
      `找到 ${recentTasks.length} 个成功任务，但均未包含有效的 refresh_token。请重新运行手机验证。`
    );
  }

  // ── Private helpers ──

  private extractTotp(raw: string): string {
    const trimmed = raw.trim();
    const urlMatch = trimmed.match(/2fa\.live\/tok\/([a-z0-9]+)/i);
    if (urlMatch) return urlMatch[1].toUpperCase();
    return trimmed.replace(/[\s\-=]/g, "").toUpperCase();
  }

  // ── Pool management ──

  /**
   * Batch move accounts from pending pool to no_ban or ban_risk pool.
   * Prerequisite: accounts must have refreshToken + familyGroupId.
   * Returns the tokens for the user to copy.
   */
  async batchMoveToPool(ids: string[], targetPool: "no_ban" | "ban_risk") {
    if (!ids.length) throw new BadRequestException("ids is required");
    if (targetPool !== "no_ban" && targetPool !== "ban_risk")
      throw new BadRequestException("targetPool must be no_ban or ban_risk");

    const accounts = await this.prisma.agentAccount.findMany({
      where: { id: { in: ids }, pool: "pending" },
    });

    const moved: Array<{ id: string; email: string; token: string }> = [];
    const errors: Array<{ id: string; email: string; error: string }> = [];

    for (const acc of accounts) {
      if (!acc.refreshToken) {
        errors.push({ id: acc.id, email: acc.loginEmail, error: "没有Token" });
        continue;
      }
      if (!acc.familyGroupId) {
        errors.push({ id: acc.id, email: acc.loginEmail, error: "未进组" });
        continue;
      }

      // Find the mother account for this family group
      const group = await this.prisma.familyGroup.findUnique({
        where: { id: acc.familyGroupId },
        select: { id: true, accountId: true },
      });

      await this.prisma.agentAccount.update({
        where: { id: acc.id },
        data: {
          pool: targetPool,
          banned: false,
          uploadedToPool: new Date(),
          motherAccountId: group?.accountId ?? null,
          motherGroupId: group?.id ?? null,
          status: "UPLOADED",
          uploadedAt: new Date(),
        },
      });
      moved.push({ id: acc.id, email: acc.loginEmail, token: acc.refreshToken });
    }

    // Check if some IDs were not found in pending pool
    const foundIds = new Set(accounts.map(a => a.id));
    for (const id of ids) {
      if (!foundIds.has(id)) {
        errors.push({ id, email: "", error: "未找到或不在未上号池" });
      }
    }

    return {
      total: ids.length,
      moved: moved.length,
      failed: errors.length,
      tokenText: moved.map(m => m.token).join("\n"),
      moved_accounts: moved,
      errors,
    };
  }

  /**
   * Toggle banned status for an account in no_ban or ban_risk pool.
   */
  async toggleBanned(id: string) {
    const account = await this.prisma.agentAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundException("AgentAccount not found");
    if (account.pool === "pending") throw new BadRequestException("未上号子号不能标记封号状态");

    const newBanned = !account.banned;
    await this.prisma.agentAccount.update({
      where: { id },
      data: { banned: newBanned },
    });
    return { id, email: account.loginEmail, banned: newBanned };
  }

  /**
   * Get mother account options for the "进组" selection dialog.
   * Returns each mother account with:
   *   - Pool child count (AgentAccounts linked to this mother)
   *   - Family group member count
   *   - Available slots
   *   - Subscription expiry
   */
  async getMotherOptions() {
    // Get all active family groups with their mother accounts
    const groups = await this.prisma.familyGroup.findMany({
      where: { status: "ACTIVE" },
      include: {
        account: {
          select: {
            id: true,
            name: true,
            loginEmail: true,
            status: true,
            subscriptionExpiresAt: true,
            subscriptionStatus: true,
          },
        },
        _count: { select: { members: true } },
      },
      orderBy: { availableSlots: "desc" },
    });

    // Count agent accounts per mother group
    const agentCounts = await this.prisma.agentAccount.groupBy({
      by: ["motherGroupId"],
      where: { motherGroupId: { not: null } },
      _count: true,
    });
    const agentCountMap = new Map(agentCounts.map(c => [c.motherGroupId!, c._count]));

    // Also count by familyGroupId for pending accounts that have joined but not yet uploaded
    const pendingCounts = await this.prisma.agentAccount.groupBy({
      by: ["familyGroupId"],
      where: { pool: "pending", familyGroupId: { not: null } },
      _count: true,
    });
    const pendingCountMap = new Map(pendingCounts.map(c => [c.familyGroupId!, c._count]));

    return groups.map(g => ({
      groupId: g.id,
      groupName: g.groupName,
      accountId: g.account.id,
      accountName: g.account.name,
      accountEmail: g.account.loginEmail,
      accountStatus: g.account.status,
      subscriptionExpiresAt: g.account.subscriptionExpiresAt,
      subscriptionStatus: g.account.subscriptionStatus,
      memberCount: g._count.members,
      availableSlots: g.availableSlots,
      poolChildCount: agentCountMap.get(g.id) ?? 0,       // 已上号号池中关联到此母号的子号数
      pendingChildCount: pendingCountMap.get(g.id) ?? 0,  // 未上号中已进此组的子号数
    }));
  }

  /**
   * Replace: swap an uploaded child account with a new one from pending pool.
   * Serial flow: remove old → invite new → new accept-invite
   * Creates a compound task that chains the operations.
   */
  async replaceInPool(oldId: string, newId: string) {
    const oldAcc = await this.prisma.agentAccount.findUnique({ where: { id: oldId } });
    if (!oldAcc) throw new NotFoundException("旧子号不存在");
    if (oldAcc.pool === "pending") throw new BadRequestException("旧子号不在已上号池");
    if (!oldAcc.motherGroupId) throw new BadRequestException("旧子号没有关联家庭组");

    const newAcc = await this.prisma.agentAccount.findUnique({ where: { id: newId } });
    if (!newAcc) throw new NotFoundException("新子号不存在");
    if (newAcc.pool !== "pending") throw new BadRequestException("新子号不在未上号池");

    // Get mother account info
    const group = await this.prisma.familyGroup.findUnique({
      where: { id: oldAcc.motherGroupId },
      include: { account: true },
    });
    if (!group) throw new BadRequestException("关联的家庭组不存在");

    // Create a compound task
    const task = await this.prisma.task.create({
      data: {
        type: "AGENT_REPLACE" as any,
        status: "PENDING",
        source: "agent-account",
        payload: JSON.stringify({
          action: "agent-replace",
          oldEmail: oldAcc.loginEmail,
          newEmail: newAcc.loginEmail,
          oldAccountId: oldId,
          newAccountId: newId,
          groupId: group.id,
          motherAccountId: group.accountId,
          motherEmail: group.account.loginEmail,
          targetPool: oldAcc.pool,
          newCredentials: {
            email: newAcc.loginEmail,
            password: newAcc.loginPassword,
            totpSecret: newAcc.totpSecret,
          },
          motherCredentials: {
            email: group.account.loginEmail,
            password: group.account.loginPassword,
            totpSecret: group.account.totpSecret,
          },
        }),
      },
    });

    // Queue as automation job
    await this.automationQueue.add("agent-replace", {
      action: "agent-replace",
      taskId: task.id,
      oldEmail: oldAcc.loginEmail,
      newEmail: newAcc.loginEmail,
      oldAccountId: oldId,
      newAccountId: newId,
      groupId: group.id,
      motherAccountId: group.accountId,
      targetPool: oldAcc.pool,
      newCredentials: {
        email: newAcc.loginEmail,
        password: newAcc.loginPassword,
        totpSecret: newAcc.totpSecret ?? undefined,
      },
      motherCredentials: {
        email: group.account.loginEmail,
        password: group.account.loginPassword,
        totpSecret: group.account.totpSecret ?? undefined,
      },
    }, {
      ...JOB_DEFAULTS,
      jobId: `automation-${task.id}`,
    });

    return {
      taskId: task.id,
      oldEmail: oldAcc.loginEmail,
      newEmail: newAcc.loginEmail,
      status: "PENDING",
    };
  }

  /**
   * Migrate: move a child account from its current mother to a new one.
   * Serial flow: remove from old group → invite by new mother → accept-invite
   */
  async migrateToMother(childId: string, newGroupId: string) {
    const child = await this.prisma.agentAccount.findUnique({ where: { id: childId } });
    if (!child) throw new NotFoundException("子号不存在");
    if (child.pool === "pending") throw new BadRequestException("未上号子号不能迁移");
    if (!child.motherGroupId) throw new BadRequestException("子号没有关联家庭组");
    if (child.motherGroupId === newGroupId) throw new BadRequestException("目标母号与当前相同");

    // Old mother info
    const oldGroup = await this.prisma.familyGroup.findUnique({
      where: { id: child.motherGroupId },
      include: { account: true },
    });
    if (!oldGroup) throw new BadRequestException("当前关联的家庭组不存在");

    // New mother info
    const newGroup = await this.prisma.familyGroup.findUnique({
      where: { id: newGroupId },
      include: { account: true },
    });
    if (!newGroup) throw new BadRequestException("目标家庭组不存在");

    // Create compound task
    const task = await this.prisma.task.create({
      data: {
        type: "AGENT_MIGRATE" as any,
        status: "PENDING",
        source: "agent-account",
        payload: JSON.stringify({
          action: "agent-migrate",
          childEmail: child.loginEmail,
          childAccountId: childId,
          oldGroupId: oldGroup.id,
          oldMotherEmail: oldGroup.account.loginEmail,
          newGroupId: newGroup.id,
          newMotherEmail: newGroup.account.loginEmail,
          childCredentials: {
            email: child.loginEmail,
            password: child.loginPassword,
            totpSecret: child.totpSecret,
          },
          oldMotherCredentials: {
            email: oldGroup.account.loginEmail,
            password: oldGroup.account.loginPassword,
            totpSecret: oldGroup.account.totpSecret,
          },
          newMotherCredentials: {
            email: newGroup.account.loginEmail,
            password: newGroup.account.loginPassword,
            totpSecret: newGroup.account.totpSecret,
          },
        }),
      },
    });

    await this.automationQueue.add("agent-migrate", {
      action: "agent-migrate",
      taskId: task.id,
      childEmail: child.loginEmail,
      childAccountId: childId,
      oldGroupId: oldGroup.id,
      newGroupId: newGroup.id,
      childCredentials: {
        email: child.loginEmail,
        password: child.loginPassword,
        totpSecret: child.totpSecret ?? undefined,
      },
      oldMotherCredentials: {
        email: oldGroup.account.loginEmail,
        password: oldGroup.account.loginPassword,
        totpSecret: oldGroup.account.totpSecret ?? undefined,
      },
      newMotherCredentials: {
        email: newGroup.account.loginEmail,
        password: newGroup.account.loginPassword,
        totpSecret: newGroup.account.totpSecret ?? undefined,
      },
    }, {
      ...JOB_DEFAULTS,
      jobId: `automation-${task.id}`,
    });

    return {
      taskId: task.id,
      childEmail: child.loginEmail,
      oldMotherEmail: oldGroup.account.loginEmail,
      newMotherEmail: newGroup.account.loginEmail,
      status: "PENDING",
    };
  }
}
