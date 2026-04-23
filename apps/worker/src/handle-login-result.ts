/**
 * Shared login result handler.
 *
 * Extracts the duplicated login-failure handling logic from all 5 processors
 * into a single reusable function. Each processor calls this after gmailLogin()
 * returns a failed result.
 *
 * === New strategy (v2) ===
 * On ANY login failure:
 *   1. Record cumulative failure count for the account
 *   2. If count >= 3 → mark account RISKY + MANUAL_REVIEW (needs human intervention)
 *   3. Otherwise → throw Error so BullMQ retries (processor may try a different account)
 *
 * ACCOUNT_LOCKED is still immediately non-retryable (SUSPENDED).
 *
 * Behavior matrix:
 *   TRANSIENT           → record failure + throw Error (BullMQ retries with possible account switch)
 *   PHONE_CHALLENGE     → record failure + throw Error
 *   CAPTCHA             → record failure + cooldown + throw Error
 *   ACCOUNT_LOCKED      → mark SUSPENDED + throw UnrecoverableError
 *   VERIFICATION_REQUIRED / UNKNOWN
 *                       → record failure, if count >= 3 mark RISKY, else throw Error
 */

import { Job, UnrecoverableError } from "bullmq";
import type { PrismaClient } from "@prisma/client";
import type { BrowserPool } from "./browser-pool";
import type { TaskLogger } from "./task-logger";
import type { GmailLoginResult } from "./gmail-login";

/** Threshold: after this many cumulative failures, mark account RISKY */
const ACCOUNT_FAILURE_THRESHOLD = 5;

export interface HandleLoginResultContext {
  job: Job;
  pool: BrowserPool;
  prisma: PrismaClient;
  logger: TaskLogger;
  accountId: string;
  /**
   * When true, the last-attempt handler returns instead of throwing
   * UnrecoverableError. Used by health.processor which needs to update
   * account status and return gracefully.
   */
  returnOnFinal?: boolean;
  /**
   * Custom account status mapping for the UNKNOWN reason.
   * Default: "VERIFICATION_REQUIRED".
   * health.processor uses "LOGIN_REQUIRED" for UNKNOWN.
   */
  unknownAccountStatus?: string;
  /**
   * Extra data to merge into the account update on final failure.
   * health.processor uses { lastHealthCheckAt: new Date() }.
   */
  extraAccountUpdate?: Record<string, unknown>;
}

/**
 * Handle a failed login result from gmailLogin().
 *
 * On success result, this is a no-op (returns immediately).
 * On failure, records cumulative failure count and either:
 *   - marks account RISKY + throws UnrecoverableError (if count >= threshold)
 *   - throws Error for BullMQ retry (processor can try a different account)
 *
 * @returns true if the handler returned without throwing (only when returnOnFinal=true)
 */
export async function handleLoginResult(
  loginResult: GmailLoginResult,
  ctx: HandleLoginResultContext
): Promise<boolean> {
  if (loginResult.success) return false;

  const { job, pool, prisma, logger, accountId } = ctx;

  // ACCOUNT_LOCKED → non-retryable, immediately mark SUSPENDED
  if (loginResult.reason === "ACCOUNT_LOCKED") {
    const LOCKED_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
    await pool.recordLoginFailure(accountId, LOCKED_COOLDOWN_MS);
    await pool.recordAccountTaskFailure(accountId);
    await prisma.account.update({
      where: { id: accountId },
      data: { status: "SUSPENDED" as any },
    });
    await logger.updateStatus("MANUAL_REVIEW", {
      code: loginResult.reason,
      message: loginResult.detail,
    });
    throw new UnrecoverableError("MANUAL_REVIEW");
  }

  // ── All other failures: record cumulative count and check threshold ──

  // CAPTCHA → also set a short cooldown to avoid hammering Google
  if (loginResult.reason === "CAPTCHA") {
    const CAPTCHA_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
    await pool.recordLoginFailure(accountId, CAPTCHA_COOLDOWN_MS);
  } else {
    // For TRANSIENT, PHONE_CHALLENGE, VERIFICATION_REQUIRED, UNKNOWN:
    // set a shorter cooldown to avoid immediate re-login
    await pool.recordLoginFailure(accountId, 2 * 60 * 1000); // 2 min cooldown
  }

  // Record cumulative failure count
  const failureCount = await pool.recordAccountTaskFailure(accountId);
  await logger.log(
    "WARN",
    `账号 ${accountId} 登录失败（原因: ${loginResult.reason}），累计失败: ${failureCount}/${ACCOUNT_FAILURE_THRESHOLD}`
  );

  // Check if we've hit the threshold → mark account RISKY for human intervention
  if (failureCount >= ACCOUNT_FAILURE_THRESHOLD) {
    const accountStatus =
      loginResult.reason === "VERIFICATION_REQUIRED"
        ? "VERIFICATION_REQUIRED"
        : (ctx.unknownAccountStatus ?? "RISKY");

    let syncError: string | null = null;
    if (loginResult.reason === "CAPTCHA") {
      syncError = "CAPTCHA_REQUIRED";
    } else if (loginResult.reason === "UNKNOWN" || loginResult.reason === "VERIFICATION_REQUIRED") {
      syncError = "PASSWORD_ERROR";
    }

    await prisma.account.update({
      where: { id: accountId },
      data: {
        status: accountStatus as any,
        syncError,
        ...(ctx.extraAccountUpdate ?? {}),
      },
    });

    if (syncError) {
      await prisma.familyGroup.updateMany({
        where: { accountId },
        data: { status: "MANUAL_ONLY" }
      });
      await logger.log("INFO", `Set all family groups for account ${accountId} to MANUAL_ONLY due to auto-sync failure (${syncError})`);
    }

    await logger.log(
      "ERROR",
      `账号 ${accountId} 累计失败 ${failureCount} 次 — 已标记为 ${accountStatus}，需要人工干预`
    );

    const reasonMap: Record<string, string> = {
      TRANSIENT: "登录页加载超时",
      PHONE_CHALLENGE: "Google要求手机验证",
      CAPTCHA: "Google要求验证码",
      ACCOUNT_LOCKED: "账号已被锁定",
      VERIFICATION_REQUIRED: "需要身份验证",
      UNKNOWN: "密码错误或登录异常",
    };
    const reasonCN = reasonMap[loginResult.reason] ?? loginResult.reason;

    await logger.updateStatus("MANUAL_REVIEW", {
      code: `ACCOUNT_${accountStatus}`,
      message: `登录失败 ${failureCount} 次（${reasonCN}），请手动检查账号`,
    });

    if (ctx.returnOnFinal) {
      return true; // Caller should return (used by health.processor)
    }

    throw new UnrecoverableError("MANUAL_REVIEW");
  }

  // Under threshold → throw Error so BullMQ retries.
  // The processor (invite/replace) can catch this and try a different account.
  throw new Error(
    `LOGIN_FAILED:${loginResult.reason}:${accountId}|${loginResult.detail}`
  );
}
