// AdsPower import domain: batch Google-credential OAuth onboarding driven by the
// automation worker, status polling, and import history. Extracted from
// RosettaService — behavior-preserving (method bodies verbatim, this.dataDir /
// this.automation / this.agentAccounts rebound to the shared RosettaContext).
// adspowerImportStatus uploads succeeded accounts to the pool via
// AgentAccountService.uploadToRosetta (ctx.agentAccounts), not a sibling domain.

import * as crypto from "crypto";
import * as path from "path";

import type { RosettaContext } from "./lib/context";
import { nowIso, readJson, writeJson } from "./lib/store";

export class AdspowerService {
  constructor(private readonly ctx: RosettaContext) {}

  private get adspowerFile() {
    return path.join(this.ctx.dataDir, "adspower-import.json");
  }

  /** Terminal item states — no further polling needed. */
  private readonly ADSPOWER_TERMINAL = new Set(["success", "failed"]);

  /** Map an automation Task status to the frontend's item status vocabulary. */
  private mapAdspowerTaskStatus(taskData: any): { status: string; message?: string; error?: string } {
    const backend = String(taskData?.status || "");
    switch (backend) {
      case "SUCCESS":
        return { status: "success" };
      case "RUNNING":
        return { status: "running", message: "登录授权中" };
      case "PENDING":
        return { status: "running", message: "排队中" };
      case "MANUAL_REVIEW":
        return {
          status: "failed",
          error: `需人工验证: ${taskData?.lastErrorCode || taskData?.lastErrorMessage || "MANUAL_REVIEW"}`,
        };
      case "FAILED_FINAL":
      case "FAILED_RETRYABLE":
        return {
          status: "failed",
          error: taskData?.lastErrorMessage || taskData?.lastErrorCode || "自动化失败",
        };
      default:
        return { status: "running" };
    }
  }

  /**
   * Submit a batch of Google credentials for AdsPower-driven OAuth onboarding.
   * Each credential is ensured to exist as an AgentAccount, then enqueued as an
   * "oauth" automation task (the worker drives an AdsPower profile, logs in, and
   * captures the refresh token). Status is polled via adspowerImportStatus(),
   * which pushes succeeded accounts into the Rosetta pool.
   */
  async adspowerImport(payload: any) {
    const credentials = payload?.credentials;
    if (!Array.isArray(credentials) || !credentials.length) return { ok: false, error: "credentials array required" };
    if (!this.ctx.automation || !this.ctx.agentAccounts) return { ok: false, error: "automation service unavailable" };

    const batchId = `batch_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
    const items: any[] = [];

    for (const c of credentials) {
      const email = String(c?.email || "").trim();
      const password = String(c?.password || "");
      if (!email || !password) {
        items.push({ email, status: "failed", error: "缺少邮箱或密码" });
        continue;
      }

      const recoveryEmail = c?.recoveryEmail ? String(c.recoveryEmail) : undefined;
      const totpSecret = c?.totpSecret ? String(c.totpSecret) : undefined;
      const phones = Array.isArray(c?.phones)
        ? c.phones
            .map((p: any) => ({
              phoneNumber: String(p?.phoneNumber || "").trim(),
              countryCode: String(p?.countryCode || "+1").trim() || "+1",
              smsUrl: String(p?.smsUrl || "").trim(),
            }))
            .filter((p: any) => p.phoneNumber)
        : undefined;

      try {
        const agentAccountId = await this.ctx.agentAccounts.ensureAgentAccount({
          loginEmail: email,
          loginPassword: password,
          totpSecret,
          recoveryEmail,
        });
        const result = await this.ctx.automation.startAutomation(
          "oauth",
          { email, password, recoveryEmail, totpSecret },
          phones?.length ? phones : undefined,
          undefined,
          { source: "rosetta-account-auto-import" },
        );
        items.push({
          email,
          agentAccountId,
          taskId: result?.taskId,
          status: "running",
          message: "已入队",
        });
      } catch (err: any) {
        items.push({ email, status: "failed", error: err?.message || String(err) });
      }
    }

    const batch = {
      batchId,
      status: items.every((i) => this.ADSPOWER_TERMINAL.has(i.status)) ? "completed" : "running",
      total: items.length,
      completed: items.filter((i) => this.ADSPOWER_TERMINAL.has(i.status)).length,
      failed: items.filter((i) => i.status === "failed").length,
      done: items.every((i) => this.ADSPOWER_TERMINAL.has(i.status)),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      items,
    };
    writeJson(this.adspowerFile, batch);
    return { ok: true, batchId };
  }

  /** Poll automation task status for each pending item; upload successes to the pool. */
  async adspowerImportStatus(batchId: string) {
    const data = readJson(this.adspowerFile, null);
    if (!data || data.batchId !== batchId) return { ok: false, error: "batch not found" };

    if (this.ctx.automation) {
      for (const item of data.items || []) {
        if (!item.taskId || this.ADSPOWER_TERMINAL.has(item.status)) continue;
        try {
          const taskData = await this.ctx.automation.getTaskStatus(item.taskId);
          const mapped = this.mapAdspowerTaskStatus(taskData);

          if (mapped.status === "success") {
            // OAuth done → token is on the AgentAccount; push it into the pool.
            if (!item.uploaded && item.agentAccountId && this.ctx.agentAccounts) {
              try {
                await this.ctx.agentAccounts.uploadToRosetta([item.agentAccountId]);
                item.uploaded = true;
                item.status = "success";
                item.message = "已录入账号池";
                item.error = "";
              } catch (err: any) {
                item.status = "failed";
                item.error = `OAuth成功但入池失败: ${err?.message || String(err)}`;
              }
            } else {
              item.status = "success";
              item.message = "已录入账号池";
            }
          } else {
            item.status = mapped.status;
            if (mapped.message !== undefined) item.message = mapped.message;
            if (mapped.error !== undefined) item.error = mapped.error;
          }
        } catch {
          // task not found yet / transient — leave item unchanged for next poll
        }
      }

      data.completed = (data.items || []).filter((i: any) => this.ADSPOWER_TERMINAL.has(i.status)).length;
      data.failed = (data.items || []).filter((i: any) => i.status === "failed").length;
      data.done = (data.items || []).every((i: any) => this.ADSPOWER_TERMINAL.has(i.status));
      data.status = data.done ? "completed" : "running";
      data.updatedAt = nowIso();
      writeJson(this.adspowerFile, data);
    }

    return { ok: true, ...data };
  }

  adspowerImportHistory() {
    const data = readJson(this.adspowerFile, null);
    if (!data) return { ok: true, batchId: null };
    return { ok: true, ...data };
  }
}
