/**
 * Shared login result handler.
 *
 * Extracts the duplicated login-failure handling logic from all 5 processors
 * into a single reusable function. Each processor calls this after gmailLogin()
 * returns a failed result.
 *
 * === Strategy ===
 * On login failure, behaviour depends on the failure reason:
 *
 * Immediately mark RISKY (needs human intervention):
 *   - CAPTCHA             → mark RISKY, set syncError=CAPTCHA_REQUIRED
 *   - PHONE_CHALLENGE     → mark RISKY, set syncError=PHONE_CHALLENGE
 *   - VERIFICATION_REQUIRED → mark VERIFICATION_REQUIRED, set syncError=PASSWORD_ERROR
 *   - UNKNOWN (password error) → mark RISKY, set syncError=PASSWORD_ERROR
 *
 * Retryable (BullMQ retries, never RISKY):
 *   - TRANSIENT (network timeout, page load failure) → throw Error
 *
 * Non-retryable:
 *   - ACCOUNT_LOCKED      → mark SUSPENDED + throw UnrecoverableError
 */

import { Job, UnrecoverableError } from "bullmq";
import type { PrismaClient } from "@prisma/client";
import type { BrowserPool } from "./browser-pool";
import type { TaskLogger } from "./task-logger";
import type { GmailLoginResult } from "./gmail-login";


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

  // TRANSIENT (network timeout, page load failure) → never mark RISKY.
  // Just set a short cooldown and let BullMQ retry.
  if (loginResult.reason === "TRANSIENT") {
    await pool.recordLoginFailure(accountId, 2 * 60 * 1000); // 2 min cooldown
    await logger.log("WARN",
      `账号 ${accountId} 登录临时失败（网络/页面加载问题），将重试`
    );
    throw new Error(
      `LOGIN_FAILED:${loginResult.reason}:${accountId}|${loginResult.detail}`
    );
  }

  // ── Security challenges: only mark account for CONFIRMED issues ──
  // CAPTCHA, PHONE_CHALLENGE, VERIFICATION_REQUIRED, UNKNOWN (password error)
  // require human intervention → mark account status + set syncError.
  // Unrecognized reasons → only set cooldown, do NOT change account status.

  if (loginResult.reason === "CAPTCHA") {
    await pool.recordLoginFailure(accountId, 5 * 60 * 1000); // 5 min cooldown
  } else {
    await pool.recordLoginFailure(accountId, 2 * 60 * 1000);
  }

  // Map reason → account status (only for confirmed issues)
  const accountStatusMap: Record<string, string> = {
    CAPTCHA: "RISKY",
    PHONE_CHALLENGE: "RISKY",
    VERIFICATION_REQUIRED: "VERIFICATION_REQUIRED",
    UNKNOWN: "RISKY",
  };
  const newAccountStatus = accountStatusMap[loginResult.reason] ?? null;

  const syncErrorMap: Record<string, string> = {
    CAPTCHA: "CAPTCHA_REQUIRED",
    PHONE_CHALLENGE: "PHONE_CHALLENGE",
    VERIFICATION_REQUIRED: "PASSWORD_ERROR",
    UNKNOWN: "PASSWORD_ERROR",
  };
  const syncError = syncErrorMap[loginResult.reason] ?? null;

  // Only update account status if we have a confirmed reason
  if (newAccountStatus && syncError) {
    await prisma.account.update({
      where: { id: accountId },
      data: {
        status: newAccountStatus as any,
        syncError,
        ...(ctx.extraAccountUpdate ?? {}),
      },
    });

    await prisma.familyGroup.updateMany({
      where: { accountId },
      data: { status: "MANUAL_ONLY" }
    });
    await logger.log("INFO", `Set all family groups for account ${accountId} to MANUAL_ONLY due to ${syncError}`);
  } else {
    // Unrecognized reason — only apply extra update (e.g. lastHealthCheckAt) if provided
    if (ctx.extraAccountUpdate) {
      await prisma.account.update({
        where: { id: accountId },
        data: ctx.extraAccountUpdate,
      });
    }
  }

  const reasonMap: Record<string, string> = {
    CAPTCHA: "Google要求验证码",
    PHONE_CHALLENGE: "Google要求手机验证",
    VERIFICATION_REQUIRED: "需要身份验证",
    UNKNOWN: "密码错误或登录异常",
  };
  const reasonCN = reasonMap[loginResult.reason] ?? loginResult.reason;
  const displayStatus = newAccountStatus ?? "（未改变）";

  await logger.log("ERROR",
    `账号 ${accountId} 登录失败（${reasonCN}）— 账号状态: ${displayStatus}，需要人工干预`
  );

  const detailSuffix = loginResult.detail ? `：${loginResult.detail}` : '';
  await logger.updateStatus("MANUAL_REVIEW", {
    code: newAccountStatus ? `ACCOUNT_${newAccountStatus}` : "LOGIN_FAILED",
    message: `登录失败（${reasonCN}${detailSuffix}），请手动检查账号`,
  });

  if (ctx.returnOnFinal) {
    return true; // Caller should return (used by health.processor)
  }

  throw new UnrecoverableError("MANUAL_REVIEW");
}
