/**
 * AutomationService — creates Task records and enqueues BullMQ jobs
 * for browser automation (OAuth, accept-invite, test-login).
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
  type AutomationPayload
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
    action: "oauth" | "accept-invite" | "test-login",
    credentials: AccountCredentials
  ) {
    // Map action to TaskType enum
    const typeMap: Record<string, string> = {
      oauth: TASK_TYPES.oauthAuthorize,
      "accept-invite": TASK_TYPES.acceptInvite,
      "test-login": TASK_TYPES.testLogin
    };

    const payload: AutomationPayload = {
      action,
      credentials: {
        email: credentials.email,
        password: credentials.password,
        recoveryEmail: credentials.recoveryEmail,
        totpSecret: credentials.totpSecret
      }
    };

    // Create Task record (no accountId — credentials are in payload)
    const task = await this.prisma.task.create({
      data: {
        type: typeMap[action] as any,
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

    // Parse result from payload if completed
    let result: Record<string, unknown> | undefined;
    if (task.status === "SUCCESS" && task.payload) {
      try {
        const parsed = JSON.parse(task.payload);
        result = parsed.result;
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
