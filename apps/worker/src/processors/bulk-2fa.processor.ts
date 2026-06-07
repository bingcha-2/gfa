import { Job } from "bullmq";
import * as fs from "fs";
import * as path from "path";
import { change2FA } from "../change-2fa";
import { WorkerBrowser } from "../browser-context";
import { gmailLogin } from "../gmail-login";
import type { Change2FAProcessorDeps } from "./change-2fa.processor";

export interface BulkJobItem {
  id: string;
  rawLine: string;
  email: string;
  password: string;
  oldSecret?: string;
  recoveryEmail?: string;
  status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";
  newSecret?: string;
  error?: string;
  screenshot?: string;
  updatedAt: string;
}

export interface BulkJob {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  createdAt: string;
  updatedAt: string;
  items: BulkJobItem[];
}

export async function processBulk2FA(
  job: Job<{ jobId: string }>,
  deps: Change2FAProcessorDeps
): Promise<void> {
  const { adspower, pool, workerId } = deps;
  const { jobId } = job.data;
  
  const dataDir = "C:/Users/Administrator/Desktop/GFA/data/bulk-2fa";
  const jobFilePath = path.join(dataDir, `job_${jobId}.json`);
  
  if (!fs.existsSync(jobFilePath)) {
    throw new Error(`Job file not found for ${jobId}`);
  }

  const readJob = (): BulkJob => JSON.parse(fs.readFileSync(jobFilePath, "utf8"));
  const writeJob = (jobData: BulkJob) => fs.writeFileSync(jobFilePath, JSON.stringify(jobData, null, 2), "utf8");

  const jobData = readJob();
  jobData.status = "PROCESSING";
  jobData.updatedAt = new Date().toISOString();
  writeJob(jobData);

  // Create a mock Logger for the inner functions
  const mockLogger = (item: BulkJobItem) => {
    return {
      log: async (level: string, msg: string) => {
        console.log(`[Bulk-2FA][${jobId}][${item.email}][${level}] ${msg}`);
      },
      updateStatus: async (status: string, err?: any) => {
        console.log(`[Bulk-2FA][${jobId}][${item.email}] Status: ${status} ${err ? JSON.stringify(err) : ""}`);
      },
      recordScreenshot: async () => {}
    } as any;
  };

  const items = jobData.items;
  
  for (let i = 0; i < items.length; i++) {
    const currentJobData = readJob();
    const item = currentJobData.items[i];
    
    if (item.status === "SUCCESS") continue; // Skip already succeeded items
    
    item.status = "RUNNING";
    item.updatedAt = new Date().toISOString();
    currentJobData.status = "PROCESSING";
    currentJobData.updatedAt = new Date().toISOString();
    writeJob(currentJobData);

    const itemLogger = mockLogger(item);
    const browser = new WorkerBrowser();
    let profileId: string | null = null;
    let stopHeartbeat: (() => void) | null = null;

    try {
      // Acquire profile + open AdsPower browser (locks using the email as accountId)
      const acquired = await pool.acquireAndOpen(workerId, item.email, adspower);
      profileId = acquired.profileId;
      stopHeartbeat = pool.startHeartbeat(profileId, item.email, workerId);
      
      const page = await browser.connect(acquired.debugUrl);

      // Attempt Gmail auto-login
      const loginResult = await gmailLogin(page, {
        loginEmail: item.email,
        loginPassword: item.password,
        totpSecret: item.oldSecret || null,
        recoveryEmail: item.recoveryEmail || null
      }, itemLogger, {
        manualChallengeWaitMs: 300000, // 允许 5 分钟人工干预时间以防遇到其它情况
        skipCaptchaManualWait: true,
        skipPhoneChallengeManualWait: true
      });
      
      if (!loginResult.success) {
        throw new Error(`Gmail login failed: ${loginResult.reason} - ${loginResult.detail}`);
      }

      // Perform the 2FA change
      const result = await change2FA(page, {
        loginEmail: item.email,
        loginPassword: item.password,
        totpSecret: item.oldSecret || null
      }, itemLogger);

      const updatedJobData = readJob();
      if (result.success) {
        updatedJobData.items[i].status = "SUCCESS";
        updatedJobData.items[i].newSecret = result.newTotpSecret;
      } else {
        updatedJobData.items[i].status = "FAILED";
        updatedJobData.items[i].error = `${result.reason}: ${result.detail}`;
      }
      updatedJobData.items[i].updatedAt = new Date().toISOString();
      writeJob(updatedJobData);

    } catch (err: any) {
      const updatedJobData = readJob();
      updatedJobData.items[i].status = "FAILED";
      updatedJobData.items[i].error = err.message || String(err);
      updatedJobData.items[i].updatedAt = new Date().toISOString();
      writeJob(updatedJobData);
    } finally {
      stopHeartbeat?.();
      await browser.disconnect().catch(() => {});
      if (profileId) {
        await adspower.closeProfile(profileId).catch(() => {});
        await pool.release(profileId, workerId).catch(() => {});
      }
      await pool.releaseAccount(item.email, workerId).catch(() => {});
    }
  }

  // Mark job as completed
  const finalJobData = readJob();
  const allDone = finalJobData.items.every(it => it.status === "SUCCESS" || it.status === "FAILED");
  finalJobData.status = allDone ? "COMPLETED" : "FAILED";
  finalJobData.updatedAt = new Date().toISOString();
  writeJob(finalJobData);
}
