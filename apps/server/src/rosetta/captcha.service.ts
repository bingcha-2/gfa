// Captcha-unblock + location-unblock flows, extracted from RosettaService.
// Behavior-preserving: method bodies are verbatim, with this.automation /
// this.logger / this.dataDir rebound to the injected deps. RosettaService keeps
// thin delegating wrappers so its public API (and all tests) stay unchanged.

import * as crypto from "crypto";
import * as path from "path";

import { Logger } from "@nestjs/common";

import { AutomationService } from "../automation/automation.service";
import { nowIso, readJson, writeJson } from "./lib/store";

export type CaptchaServiceDeps = {
  dataDir: string;
  automation?: AutomationService;
  logger: Logger;
};

export class CaptchaService {
  constructor(private readonly deps: CaptchaServiceDeps) {}

  private get captchaFile() {
    return path.join(this.deps.dataDir, "captcha-unblock.json");
  }

  async createCaptchaUnblock(payload: any) {
    let creds = payload?.credentials;
    let inputPhones = payload?.phones || [];

    if (!creds && Array.isArray(payload?.accounts) && payload.accounts.length > 0) {
      const acc = payload.accounts[0];
      creds = {
        email: acc.email,
        password: acc.password,
        recoveryEmail: acc.recoveryEmail,
        totpSecret: acc.totpSecret,
      };
      if (acc.phone) {
        inputPhones = [{
          phoneNumber: acc.phone,
          smsUrl: acc.smsUrl || "",
        }];
      }
    }

    if (!creds?.email || !creds?.password) return { ok: false, error: "email and password required" };

    const data = readJson(this.captchaFile, { tasks: [], phase2: [] });

    const normalizeEmail = (e: string) => String(e || "").trim().toLowerCase();
    const emailNorm = normalizeEmail(creds.email);
    const phase = String(payload.phase || "first");
    const source = phase === "second" ? "captcha-unblock-phase2" : "captcha-unblock";

    const task: any = {
      id: `unblock_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
      email: creds.email,
      password: creds.password,
      recoveryEmail: creds.recoveryEmail || "",
      totpSecret: creds.totpSecret || "",
      phones: inputPhones,
      phase,
      source,
      status: "PENDING",
      createdAt: nowIso(),
      lastErrorMessage: "",
      lastErrorCode: "",
      usedPhone: "",
    };

    // For phase 2, try to find existing phase 1 task to get usedPhone
    if (phase === "second") {
      const existing = (data.tasks || []).find(
        (t: any) => normalizeEmail(t.email) === emailNorm && t.usedPhone && t.status === "WAITING_SECOND_VERIFY"
      );
      if (existing) {
        task.usedPhone = existing.usedPhone;
        existing.status = "PHASE2_STARTED";
        existing.updatedAt = nowIso();
      }
    }

    data.tasks.push(task);

    // Keep last 500 tasks
    if (data.tasks.length > 500) {
      data.tasks = data.tasks.slice(-500);
    }

    writeJson(this.captchaFile, data);

    // Submit to backend worker queue
    if (this.deps.automation) {
      try {
        const autoResult = await this.deps.automation.startAutomation(
          "oauth",
          {
            email: creds.email,
            password: creds.password,
            recoveryEmail: creds.recoveryEmail || "",
            totpSecret: creds.totpSecret || "",
          },
          task.phones?.map((p: any) => ({
            phoneNumber: p.phoneNumber,
            countryCode: p.countryCode ?? "+1",
            smsUrl: p.smsUrl || "",
          })),
          undefined,
          {
            source,
            keepBrowserOpenOnChallenge: true,
          }
        );
        if (autoResult?.taskId) {
          task.taskId = autoResult.taskId;
          task.status = "RUNNING";
          task.updatedAt = nowIso();
          writeJson(this.captchaFile, data);
        }
      } catch (err: any) {
        this.deps.logger.warn(`[captcha-unblock] Failed to submit to queue for ${creds.email}: ${err.message}`);
      }
    }

    return { ok: true, taskId: task.id, email: task.email };
  }

  async getCaptchaUnblockStatus() {
    const data = readJson(this.captchaFile, { tasks: [], phase2: [] });

    // Sync status from DB for running/pending tasks
    if (this.deps.automation) {
      for (const task of (data.tasks || [])) {
        if (task.taskId && ["RUNNING", "PENDING"].includes(task.status)) {
          try {
            const taskData = await this.deps.automation.getTaskStatus(task.taskId);
            if (taskData) {
              const backendStatus = String(taskData.status || "");
              if (backendStatus === "SUCCESS") {
                task.status = task.phase === "second" ? "UNBLOCKED" : "APPEAL_REQUIRED";
                task.updatedAt = nowIso();
              } else if (backendStatus === "MANUAL_REVIEW") {
                const code = String(taskData.lastErrorCode || "");
                if (code === "PHONE_VERIFIED_APPEAL_REQUIRED") {
                  task.status = "APPEAL_REQUIRED";
                  // Extract used phone from task result
                  const res = taskData.result as any;
                  if (res?.usedPhone?.phoneNumber) {
                    task.usedPhone = res.usedPhone.phoneNumber;
                  } else if (res?.usedPhone) {
                    task.usedPhone = res.usedPhone;
                  }
                } else if (code === "CAPTCHA") {
                  task.status = "CAPTCHA_WAITING";
                } else {
                  task.status = "MANUAL_REVIEW";
                  task.lastErrorCode = code;
                  task.lastErrorMessage = taskData.lastErrorMessage || "";
                }
                task.updatedAt = nowIso();
              } else if (backendStatus === "FAILED_FINAL" || backendStatus === "FAILED_RETRYABLE") {
                task.status = "FAILED_FINAL";
                task.lastErrorCode = taskData.lastErrorCode || "";
                task.lastErrorMessage = taskData.lastErrorMessage || "";
                task.updatedAt = nowIso();
              }
            }
          } catch (err) {
            // silent
          }
        }
      }
      writeJson(this.captchaFile, data);
    }

    // Split into active tasks and phase2 waiting
    const tasks = (data.tasks || []).filter((t: any) => t.status !== "WAITING_SECOND_VERIFY");
    const phase2 = (data.tasks || []).filter((t: any) => t.status === "WAITING_SECOND_VERIFY" || t.status === "APPEAL_REQUIRED");

    return { ok: true, tasks, phase2 };
  }

  async retryCaptchaUnblock(payload: any) {
    const taskId = String(payload?.taskId || "");
    const data = readJson(this.captchaFile, { tasks: [], phase2: [] });
    const task = (data.tasks || []).find((t: any) => t.id === taskId);
    if (!task) return { ok: false, error: "task not found" };

    task.status = "PENDING";
    task.lastErrorMessage = "";
    task.lastErrorCode = "";
    task.updatedAt = nowIso();
    writeJson(this.captchaFile, data);

    // Re-submit to automation service
    if (this.deps.automation) {
      try {
        const autoResult = await this.deps.automation.startAutomation(
          "oauth",
          {
            email: task.email,
            password: task.password,
            recoveryEmail: task.recoveryEmail || "",
            totpSecret: task.totpSecret || "",
          },
          task.phones?.map((p: any) => ({
            phoneNumber: p.phoneNumber,
            countryCode: p.countryCode ?? "+1",
            smsUrl: p.smsUrl || "",
          })),
          undefined,
          {
            source: task.source || "captcha-unblock",
            keepBrowserOpenOnChallenge: true,
          }
        );
        if (autoResult?.taskId) {
          task.taskId = autoResult.taskId;
          task.status = "RUNNING";
          task.updatedAt = nowIso();
          writeJson(this.captchaFile, data);
        }
      } catch (err: any) {
        this.deps.logger.warn(`[captcha-unblock] Retry submit failed for ${task.email}: ${err.message}`);
      }
    }

    return { ok: true, taskId };
  }

  unblockLocation() {
    const accountsFile = path.join(this.deps.dataDir, "accounts.json");
    const data = readJson(accountsFile, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    let unblocked = 0;
    for (const acc of accounts) {
      if (acc.quotaStatusReason === "location_unsupported") {
        delete acc.quotaStatusReason;
        delete acc.quotaStatus;
        delete acc.blockedUntil;
        unblocked++;
      }
    }
    if (unblocked > 0) writeJson(accountsFile, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, unblocked };
  }
}
