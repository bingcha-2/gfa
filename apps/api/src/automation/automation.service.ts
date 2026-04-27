/**
 * AutomationService — creates Task records and enqueues BullMQ jobs
 * for browser automation (OAuth, accept-invite).
 *
 * Credentials are passed from the client (local SQLite) in each request.
 * The server does NOT store account credentials — they live only in the
 * BullMQ job payload for the duration of the task.
 */

import {
  Injectable,
  NotFoundException,
  BadRequestException
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import {
  QUEUE_NAMES,
  TASK_TYPES,
  JOB_DEFAULTS,
  type AutomationPayload,
  type PhoneInfo
} from "@gfa/shared";

/** OAuth constants — moved from gfa-client Rust code */
const OAUTH_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const OAUTH_CLIENT_SECRET = "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";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

interface AccountCredentials {
  email: string;
  password: string;
  recoveryEmail?: string;
  totpSecret?: string;
}

@Injectable()
export class AutomationService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.automation)
    private readonly automationQueue: Queue
  ) {}

  /**
   * Start a single automation task.
   * Credentials come from the client — not looked up from DB.
   * Creates a Task record, enqueues BullMQ job, returns taskId for polling.
   */
  async startAutomation(
    action: "oauth" | "accept-invite" | "phone-verify" | "family-join",
    credentials: AccountCredentials,
    phones?: PhoneInfo[],
    childCredentials?: AccountCredentials
  ) {
    // Map action to TaskType enum
    const typeMap: Record<string, string> = {
      oauth: TASK_TYPES.oauthAuthorize,
      "accept-invite": TASK_TYPES.acceptInvite,
      "phone-verify": TASK_TYPES.phoneVerify,
      "family-join": TASK_TYPES.acceptInvite
    };

    const taskType = typeMap[action] as any;

    // ── Dedup: reject if an active task already exists for this email + action ──
    // Task.payload stores JSON like { action, email }, so we query by type + status
    // and then filter by email in the payload to avoid duplicate browser sessions.
    const activeTasks = await this.prisma.task.findMany({
      where: {
        type: taskType,
        status: { in: ["PENDING", "RUNNING"] }
      },
      orderBy: { createdAt: "desc" },
      take: 20 // limit scan scope
    });

    const existing = activeTasks.find((t) => {
      try {
        const p = JSON.parse(t.payload);
        return p.email === credentials.email && (!childCredentials?.email || p.childEmail === childCredentials.email);
      } catch {
        return false;
      }
    });

    if (existing) {
      // Return the existing task — client can continue polling it
      return {
        taskId: existing.id,
        action,
        email: credentials.email,
        status: existing.status
      };
    }

    const payload: AutomationPayload = {
      action,
      credentials: {
        email: credentials.email,
        password: credentials.password,
        recoveryEmail: credentials.recoveryEmail,
        totpSecret: credentials.totpSecret
      },
      childCredentials: childCredentials ? {
        email: childCredentials.email,
        password: childCredentials.password,
        recoveryEmail: childCredentials.recoveryEmail,
        totpSecret: childCredentials.totpSecret
      } : undefined,
      phones: phones?.length ? phones : undefined
    };

    // Create Task record (no accountId — credentials are in payload)
    const task = await this.prisma.task.create({
      data: {
        type: taskType,
        status: "PENDING",
        // Store action + email (NOT password) for display purposes
        payload: JSON.stringify({ action, email: credentials.email, childEmail: childCredentials?.email })
      }
    });

    // Enqueue BullMQ job with full credentials
    await this.automationQueue.add(
      action,
      { ...payload, taskId: task.id },
      {
        ...JOB_DEFAULTS,
        jobId: `automation-${task.id}`
      }
    );

    return {
      taskId: task.id,
      action,
      email: credentials.email,
      status: "PENDING"
    };
  }

  /**
   * Batch OAuth — creates tasks for multiple accounts.
   */
  async batchOAuth(accounts: AccountCredentials[]) {
    const results: Array<{
      email: string;
      taskId?: string;
      error?: string;
    }> = [];

    for (const cred of accounts) {
      try {
        const result = await this.startAutomation("oauth", cred);
        results.push({ email: cred.email, taskId: result.taskId });
      } catch (e) {
        results.push({
          email: cred.email,
          error: e instanceof Error ? e.message : String(e)
        });
      }
    }

    return {
      total: accounts.length,
      queued: results.filter((r) => r.taskId).length,
      failed: results.filter((r) => r.error).length,
      results
    };
  }

  /**
   * Get automation task status — used by client polling.
   * Includes task logs for progress display.
   */
  async getTaskStatus(taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        logs: { orderBy: { createdAt: "asc" }, take: 200 }
      }
    });
    if (!task) throw new NotFoundException("Task not found");

    // Parse result from payload if task reached a terminal state
    let result: Record<string, unknown> | undefined;
    if ((task.status === "SUCCESS" || task.status === "FAILED_FINAL") && task.payload) {
      try {
        const parsed = JSON.parse(task.payload);
        result = parsed.result;
        // Also include phoneVerifyResult (from accept-invite with phone verification sub-step)
        if (parsed.phoneVerifyResult) {
          result = { ...result, phoneVerifyResult: parsed.phoneVerifyResult };
        }
        // Include OAuth token data so client can save it
        if (parsed.token) {
          result = { ...result, ...parsed.token };
        }
      } catch {
        // ignore parse errors
      }
    }

    return {
      taskId: task.id,
      type: task.type,
      status: task.status,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      lastErrorCode: task.lastErrorCode,
      lastErrorMessage: task.lastErrorMessage,
      result,
      logs: task.logs.map((l: { level: string; message: string; createdAt: Date }) => ({
        level: l.level,
        message: l.message,
        createdAt: l.createdAt
      }))
    };
  }

  /**
   * Exchange OAuth authorization code for tokens.
   * Called by the worker after completing OAuth automation.
   */
  async exchangeOAuthCode(
    code: string,
    redirectUri: string
  ): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }> {
    const params = new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    });

    const response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });

    if (!response.ok) {
      const text = await response.text();
      throw new BadRequestException(`Token exchange failed: ${text}`);
    }

    const data = await response.json();
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? "",
      expires_in: data.expires_in ?? 3600
    };
  }

  /**
   * Start an automation task from the web console.
   * Uses credentials stored in the Account DB record.
   */
  async consoleStart(accountId: string, action: "accept-invite" | "phone-verify") {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        loginEmail: true,
        loginPassword: true,
        totpSecret: true,
        recoveryEmail: true,
        status: true,
      },
    });

    if (!account) throw new NotFoundException("Account not found");
    if (!account.loginPassword) {
      throw new BadRequestException(`Account ${account.loginEmail} has no password configured`);
    }

    // Get available phones from PhonePool for phone-verify or accept-invite
    const phones = await this.prisma.phonePool.findMany({
      where: { status: "available" },
      orderBy: { usedCount: "asc" },
      take: 5,
      select: { phoneNumber: true, countryCode: true, smsUrl: true },
    });

    const phoneInfos: PhoneInfo[] = phones.map((p) => ({
      phoneNumber: p.phoneNumber,
      countryCode: p.countryCode,
      smsUrl: p.smsUrl,
    }));

    return this.startAutomation(
      action,
      {
        email: account.loginEmail,
        password: account.loginPassword,
        recoveryEmail: account.recoveryEmail ?? undefined,
        totpSecret: account.totpSecret ?? undefined,
      },
      phoneInfos.length > 0 ? phoneInfos : undefined
    );
  }

  // ── Phone pool helpers (for console) ──

  async listPhonePool() {
    return this.prisma.phonePool.findMany({ orderBy: { createdAt: "desc" } });
  }

  async importPhones(lines: string[], source?: string) {
    const phones = lines
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((line) => {
        const parts = line.split("|").map((p) => p.trim());
        if (parts.length === 2) {
          return { phoneNumber: parts[0], smsUrl: parts[1], countryCode: "+1" };
        } else if (parts.length >= 3) {
          return { countryCode: parts[0], phoneNumber: parts[1], smsUrl: parts[2] };
        }
        return null;
      })
      .filter(Boolean) as Array<{ phoneNumber: string; smsUrl: string; countryCode: string }>;

    const results: Array<{ phoneNumber: string; action: string }> = [];
    for (const p of phones) {
      const existing = await this.prisma.phonePool.findUnique({
        where: { phoneNumber: p.phoneNumber },
      });
      if (existing) {
        await this.prisma.phonePool.update({
          where: { phoneNumber: p.phoneNumber },
          data: { smsUrl: p.smsUrl },
        });
        results.push({ phoneNumber: p.phoneNumber, action: "updated" });
      } else {
        await this.prisma.phonePool.create({
          data: {
            phoneNumber: p.phoneNumber,
            countryCode: p.countryCode,
            smsUrl: p.smsUrl,
            status: "available",
            source: source ?? "console",
          },
        });
        results.push({ phoneNumber: p.phoneNumber, action: "created" });
      }
    }
    return { total: phones.length, results };
  }

  async togglePhone(id: string) {
    const phone = await this.prisma.phonePool.findUnique({ where: { id } });
    if (!phone) throw new NotFoundException("Phone not found");
    // Do not allow toggling a "used" phone back to available
    if (phone.status === "used") {
      throw new BadRequestException("已使用的手机号不能重新启用");
    }
    const newStatus = phone.status === "available" ? "disabled" : "available";
    return this.prisma.phonePool.update({
      where: { id },
      data: {
        status: newStatus,
        disabledReason: newStatus === "disabled" ? "manually_disabled" : null,
      },
    });
  }

  async deletePhoneFromPool(id: string) {
    return this.prisma.phonePool.delete({ where: { id } });
  }

  // ── Daily records (console "每日记录" tab) ──

  /**
   * Returns invite tasks originated from the agent-service panel
   * (source = "agent-service"), cross-referenced with FamilyMember
   * for current membership status. Only tracks child accounts
   * added through the 代理服务 module.
   */
  async getDailyRecords(days: number = 7) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    // Query tasks tagged with source "agent-service"
    const tasks = await this.prisma.task.findMany({
      where: {
        source: "agent-service",
        type: "INVITE_MEMBER",
        createdAt: { gte: since },
      },
      include: {
        familyGroup: {
          select: {
            id: true,
            groupName: true,
            account: {
              select: {
                id: true,
                loginEmail: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Extract emails from task payloads
    const emailFamilyKeys: Array<{ email: string; familyGroupId: string | null }> = [];
    for (const t of tasks) {
      try {
        const p = JSON.parse(t.payload);
        if (p.userEmail) {
          emailFamilyKeys.push({ email: p.userEmail, familyGroupId: t.familyGroupId });
        }
      } catch { /* skip malformed */ }
    }

    // Cross-reference with FamilyMember for current status
    const uniqueEmails = [...new Set(emailFamilyKeys.map((k) => k.email))];
    const members = uniqueEmails.length > 0
      ? await this.prisma.familyMember.findMany({
          where: { email: { in: uniqueEmails }, status: { not: "REMOVED" } },
          select: { email: true, status: true, joinedAt: true, familyGroupId: true },
        })
      : [];

    const memberMap = new Map<string, { status: string; joinedAt: Date | null }>();
    for (const m of members) {
      memberMap.set(`${m.email}:${m.familyGroupId}`, { status: m.status, joinedAt: m.joinedAt });
    }

    return tasks.map((task) => {
      let email = "";
      try {
        email = JSON.parse(task.payload).userEmail ?? "";
      } catch { /* skip */ }

      const member = memberMap.get(`${email}:${task.familyGroupId}`);

      return {
        id: task.id,
        email,
        taskStatus: task.status,
        memberStatus: member?.status ?? null,
        joinedAt: member?.joinedAt?.toISOString() ?? null,
        createdAt: task.createdAt,
        familyGroupId: task.familyGroupId,
        familyGroup: task.familyGroup,
      };
    });
  }

  // ── Account Token Management (母号 Refresh Token 提取) ──

  /**
   * List parent accounts with credentials and token status.
   * Supports pagination (page/pageSize) and sorting by createdAt desc.
   */
  async listAccountTokens(page: number = 1, pageSize: number = 20) {
    const where = { loginPassword: { not: null } };
    const [items, total] = await Promise.all([
      this.prisma.account.findMany({
        where,
        select: {
          id: true,
          name: true,
          loginEmail: true,
          status: true,
          refreshToken: true,
          tokenObtainedAt: true,
          tokenStatus: true,
          subscriptionPlan: true,
          subscriptionStatus: true,
          subscriptionExpiresAt: true,
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.account.count({ where }),
    ]);

    // Compute summary counts from full set (lightweight count queries)
    const [unusedCount, usedCount, noTokenCount] = await Promise.all([
      this.prisma.account.count({ where: { ...where, refreshToken: { not: null }, tokenStatus: "unused" } }),
      this.prisma.account.count({ where: { ...where, refreshToken: { not: null }, tokenStatus: "used" } }),
      this.prisma.account.count({ where: { ...where, refreshToken: null } }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      summary: { unused: unusedCount, used: usedCount, noToken: noTokenCount },
    };
  }

  /**
   * Trigger phone verification for a parent account.
   * Reuses the existing consoleStart flow.
   */
  async triggerAccountPhoneVerify(accountId: string) {
    return this.consoleStart(accountId, "phone-verify");
  }

  /**
   * Batch trigger phone verification for multiple parent accounts.
   */
  async batchTriggerAccountPhoneVerify(accountIds: string[]) {
    const results: Array<{ accountId: string; email: string; taskId?: string; error?: string }> = [];

    for (const accountId of accountIds) {
      try {
        const result = await this.consoleStart(accountId, "phone-verify");
        results.push({ accountId, email: result.email, taskId: result.taskId });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ accountId, email: "", error: msg });
      }
    }

    return {
      total: accountIds.length,
      queued: results.filter((r) => r.taskId).length,
      failed: results.filter((r) => r.error).length,
      results,
    };
  }

  /**
   * Extract refresh_token from a completed task and save it to the Account.
   */
  async extractAccountToken(taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
    });

    if (!task) throw new NotFoundException("Task not found");
    if (task.status !== "SUCCESS") {
      throw new BadRequestException(`Task is ${task.status}, not SUCCESS`);
    }

    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(task.payload || "{}");
    } catch {
      throw new BadRequestException("Cannot parse task payload");
    }

    // Token can be in different locations depending on task type
    const refreshToken =
      parsed.token?.refresh_token ||
      parsed.result?.refresh_token ||
      "";

    if (!refreshToken) {
      throw new BadRequestException("No refresh_token found in task result");
    }

    const email = parsed.email;
    if (!email) {
      throw new BadRequestException("No email found in task payload");
    }

    // Find the parent account by email
    const account = await this.prisma.account.findFirst({
      where: { loginEmail: email },
    });

    if (!account) {
      throw new NotFoundException(`Account not found for email: ${email}`);
    }

    await this.prisma.account.update({
      where: { id: account.id },
      data: {
        refreshToken,
        tokenObtainedAt: new Date(),
        tokenStatus: "unused",
      },
    });

    return {
      accountId: account.id,
      email: account.loginEmail,
      tokenPrefix: refreshToken.substring(0, 20) + "...",
      tokenStatus: "unused",
    };
  }

  /**
   * Mark an account's token status as used/unused.
   */
  async updateAccountTokenStatus(accountId: string, status: "used" | "unused") {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, refreshToken: true },
    });

    if (!account) throw new NotFoundException("Account not found");
    if (!account.refreshToken) {
      throw new BadRequestException("Account has no refresh token");
    }

    await this.prisma.account.update({
      where: { id: accountId },
      data: { tokenStatus: status },
    });

    return { accountId, tokenStatus: status };
  }

  /**
   * Delete an account's refresh token.
   */
  async deleteAccountToken(accountId: string) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, loginEmail: true, refreshToken: true },
    });

    if (!account) throw new NotFoundException("Account not found");

    await this.prisma.account.update({
      where: { id: accountId },
      data: { refreshToken: null, tokenObtainedAt: null, tokenStatus: null },
    });

    return { accountId, email: account.loginEmail, deleted: true };
  }
}
