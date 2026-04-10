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
    action: "oauth" | "accept-invite" | "phone-verify",
    credentials: AccountCredentials,
    phones?: PhoneInfo[]
  ) {
    // Map action to TaskType enum
    const typeMap: Record<string, string> = {
      oauth: TASK_TYPES.oauthAuthorize,
      "accept-invite": TASK_TYPES.acceptInvite,
      "phone-verify": TASK_TYPES.phoneVerify
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
        return p.email === credentials.email;
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
      phones: phones?.length ? phones : undefined
    };

    // Create Task record (no accountId — credentials are in payload)
    const task = await this.prisma.task.create({
      data: {
        type: taskType,
        status: "PENDING",
        // Store action + email (NOT password) for display purposes
        payload: JSON.stringify({ action, email: credentials.email })
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
        logs: { orderBy: { createdAt: "desc" }, take: 50 }
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
}
