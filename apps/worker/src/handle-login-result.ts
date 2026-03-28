/**
 * Shared login result handler.
 *
 * Extracts the duplicated login-failure handling logic from all 5 processors
 * into a single reusable function. Each processor calls this after gmailLogin()
 * returns a failed result.
 *
 * Behavior matrix:
 *   TRANSIENT         → throw Error (BullMQ retries)
 *   PHONE_CHALLENGE   → recordLoginFailure + throw Error (BullMQ retries)
 *   CAPTCHA           → recordLoginFailure(5min) + throw Error (BullMQ retries)
 *   ACCOUNT_LOCKED    → recordLoginFailure(30min) + mark account SUSPENDED
 *                        + updateStatus MANUAL_REVIEW + throw UnrecoverableError
 *   VERIFICATION_REQUIRED / UNKNOWN (last attempt)
 *                     → recordLoginFailure + mark account + updateStatus MANUAL_REVIEW
 *                        + throw UnrecoverableError (or return for health)
 *   VERIFICATION_REQUIRED / UNKNOWN (not last attempt)
 *                     → throw Error (BullMQ retries)
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
 * On failure, throws an appropriate Error or UnrecoverableError
 * (unless returnOnFinal is true for the last-attempt path).
 *
 * @returns true if the handler returned without throwing (only when returnOnFinal=true on last attempt)
 */
export async function handleLoginResult(
  loginResult: GmailLoginResult,
  ctx: HandleLoginResultContext
): Promise<boolean> {
  if (loginResult.success) return false;

  const { job, pool, prisma, logger, accountId } = ctx;

  // TRANSIENT failures (e.g. password page didn't load) → let BullMQ retry
  if (loginResult.reason === "TRANSIENT") {
    throw new Error(`Login transient failure: ${loginResult.detail}`);
  }

  // PHONE_CHALLENGE → retryable (Google resets risk on profile reopen)
  if (loginResult.reason === "PHONE_CHALLENGE") {
    await pool.recordLoginFailure(accountId);
    throw new Error(`Phone challenge (will retry): ${loginResult.detail}`);
  }

  // CAPTCHA → retryable with short cooldown
  if (loginResult.reason === "CAPTCHA") {
    const CAPTCHA_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
    await pool.recordLoginFailure(accountId, CAPTCHA_COOLDOWN_MS);
    throw new Error(`CAPTCHA challenge (will retry): ${loginResult.detail}`);
  }

  // ACCOUNT_LOCKED → non-retryable, long cooldown
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

  // VERIFICATION_REQUIRED or UNKNOWN → only mark account on LAST attempt
  const isLastAttempt = (job.attemptsMade ?? 0) >= 2;
  if (isLastAttempt) {
    await pool.recordLoginFailure(accountId);

    const accountStatus =
      loginResult.reason === "VERIFICATION_REQUIRED"
        ? "VERIFICATION_REQUIRED"
        : (ctx.unknownAccountStatus ?? "VERIFICATION_REQUIRED");

    await prisma.account.update({
      where: { id: accountId },
      data: {
        status: accountStatus as any,
        ...(ctx.extraAccountUpdate ?? {}),
      },
    });

    await logger.updateStatus("MANUAL_REVIEW", {
      code: loginResult.reason,
      message: loginResult.detail,
    });

    if (ctx.returnOnFinal) {
      return true; // Caller should return (used by health.processor)
    }

    throw new UnrecoverableError("MANUAL_REVIEW");
  }

  // Not last attempt — let BullMQ retry
  throw new Error(
    `Login failed (attempt ${(job.attemptsMade ?? 0) + 1}/3, will retry): ${loginResult.detail}`
  );
}
