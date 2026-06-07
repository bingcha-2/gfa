/**
 * Change 2FA (TOTP) processor.
 *
 * Logs into the account, changes the Google Authenticator TOTP secret,
 * and persists the new secret (backing up the old one).
 */

import { Job, UnrecoverableError } from "bullmq";
import { PrismaClient } from "@prisma/client";
import type { Change2FAPayload } from "@gfa/shared";

import { AdsPowerClient } from "../adspower-client";
import { BrowserPool } from "../browser-pool";
import { WorkerBrowser } from "../browser-context";
import { TaskLogger } from "../task-logger";
import { gmailLogin } from "../gmail-login";
import { handleLoginResult } from "../handle-login-result";
import { change2FA } from "../change-2fa";

export interface Change2FAProcessorDeps {
  prisma: PrismaClient;
  adspower: AdsPowerClient;
  pool: BrowserPool;
  workerId: string;
}

export async function processChange2FA(
  job: Job<Change2FAPayload>,
  deps: Change2FAProcessorDeps
): Promise<void> {
  const { prisma, adspower, pool, workerId } = deps;
  const { accountId } = job.data;
  const taskId = job.data.taskId ?? job.id ?? job.name;
  if (!taskId) {
    console.error(`[worker:${workerId}] change-2fa job has no id or name, skipping`);
    return;
  }

  const logger = new TaskLogger(prisma, taskId, workerId);
  const browser = new WorkerBrowser();

  const account = await prisma.account.findUnique({
    where: { id: accountId },
  });
  if (!account) {
    await logger.updateStatus("FAILED_FINAL", {
      code: "ACCOUNT_NOT_FOUND",
      message: `账号 ${accountId} 不存在`,
    });
    return;
  }

  let profileId: string | null = null;
  let stopHeartbeat: (() => void) | null = null;

  try {
    // Cooldown guard: skip immediately if this account recently failed login
    if (!job.data.ignoreCooldown) {
      const cooldownSecs = await pool.isLoginCoolingDown(accountId);
      if (cooldownSecs > 0) {
        await logger.log("WARN", `[change-2fa] 主号登录冷却中（剩余 ${cooldownSecs} 秒），跳过本次换绑`);
        await logger.updateStatus("FAILED_RETRYABLE", { code: "LOGIN_COOLDOWN", message: `主号登录冷却中，剩余 ${cooldownSecs} 秒` });
        throw new Error(`LOGIN_COOLDOWN: ${cooldownSecs}s remaining`);
      }
    }

    // Acquire profile + open AdsPower browser (retries other profiles on failure)
    const acquired = await pool.acquireAndOpen(workerId, accountId, adspower);
    profileId = acquired.profileId;
    stopHeartbeat = pool.startHeartbeat(profileId, accountId, workerId);
    await logger.log("INFO", `Change 2FA for account ${account.name}`, { profileId });

    await logger.updateStatus("RUNNING");
    const page = await browser.connect(acquired.debugUrl);

    // Attempt Gmail auto-login
    const loginResult = await gmailLogin(page, account, logger);
    if (!loginResult.success) {
      const handled = await handleLoginResult(loginResult, {
        job, pool, prisma, logger,
        accountId,
        returnOnFinal: true,
        unknownAccountStatus: "LOGIN_REQUIRED",
      });
      if (handled) return;
    }

    // Record last account on this profile
    pool.setLastAccount(profileId, accountId);

    // Perform the 2FA change
    if (!account.loginPassword) {
      await logger.updateStatus("FAILED_FINAL", { code: "NO_PASSWORD", message: "账号没有密码，无法修改 2FA" });
      return;
    }
    const result = await change2FA(page, {
      loginEmail: account.loginEmail,
      loginPassword: account.loginPassword,
      totpSecret: account.totpSecret,
    }, logger);

    if (result.success) {
      // Persist new TOTP secret and back up the old one
      try {
        await prisma.account.update({
          where: { id: accountId },
          data: {
            totpSecret: result.newTotpSecret,
            // totpSecretPrev and totpChangedAt may not exist yet
            ...({ totpSecretPrev: account.totpSecret, totpChangedAt: new Date() } as any),
          },
        });
      } catch {
        // totpSecretPrev / totpChangedAt may not exist in schema yet — fall back
        await prisma.account.update({
          where: { id: accountId },
          data: {
            totpSecret: result.newTotpSecret,
          },
        });
        await logger.log("WARN", "[change-2fa] totpSecretPrev/totpChangedAt fields missing, saved totpSecret only");
      }

      await logger.updateStatus("SUCCESS");
      await logger.log("INFO", `[change-2fa] 2FA changed successfully. New secret: ${result.newTotpSecret.slice(0, 4)}****`);
    } else {
      // Determine failure severity based on reason
      switch (result.reason) {
        case "REAUTH_FAILED":
        case "NO_AUTHENTICATOR_PAGE":
        case "NO_CHANGE_BUTTON":
        case "SECRET_EXTRACT_FAILED":
        case "VERIFY_FAILED":
          await logger.updateStatus("MANUAL_REVIEW", {
            code: result.reason,
            message: result.detail,
          });
          throw new UnrecoverableError(`${result.reason}: ${result.detail}`);

        case "TRANSIENT":
          await logger.updateStatus("FAILED_RETRYABLE", {
            code: result.reason,
            message: result.detail,
          });
          throw new Error(`${result.reason}: ${result.detail}`);

        default:
          await logger.updateStatus("FAILED_RETRYABLE", {
            code: result.reason,
            message: result.detail,
          });
          throw new Error(`${result.reason}: ${result.detail}`);
      }
    }
  } catch (error) {
    if (error instanceof UnrecoverableError) throw error;

    const errMsg = error instanceof Error ? error.message : String(error);

    await logger.updateStatus("FAILED_RETRYABLE", {
      code: profileId ? "CHANGE_2FA_ERROR" : "PROFILE_ACQUIRE_FAILED",
      message: errMsg,
    });

    throw error;
  } finally {
    stopHeartbeat?.();
    await browser.disconnect().catch(() => {});
    if (profileId) {
      await adspower.closeProfile(profileId).catch(() => {});
      await pool.release(profileId, workerId).catch(() => {});
    }
    await pool.releaseAccount(accountId, workerId).catch(() => {});
  }
}
