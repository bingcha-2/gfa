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

  // Helper function to update bulk item status in the JSON file atomically
  const updateItemInJobFile = (itemId: string, updater: (item: BulkJobItem) => void) => {
    const data = readJob();
    const item = data.items.find(it => it.id === itemId);
    if (item) {
      updater(item);
    }
    const allDone = data.items.every(it => it.status === "SUCCESS" || it.status === "FAILED");
    data.status = allDone ? "COMPLETED" : "PROCESSING";
    data.updatedAt = new Date().toISOString();
    writeJob(data);
  };

  let nextIndex = 0;

  async function worker() {
    while (true) {
      let currentIndex = -1;
      let item: BulkJobItem | undefined;

      // Select next item synchronously to avoid race conditions
      if (nextIndex < items.length) {
        currentIndex = nextIndex++;
        const currentJob = readJob();
        item = currentJob.items[currentIndex];
      }

      if (!item) break; // Finished all items
      if (item.status === "SUCCESS" || item.status === "FAILED") continue;

      // Update item state to RUNNING atomically
      updateItemInJobFile(item.id, (it) => {
        it.status = "RUNNING";
        it.updatedAt = new Date().toISOString();
      });

      const itemLogger = mockLogger(item);
      const maxItemAttempts = 2;
      let success = false;

      for (let attempt = 1; attempt <= maxItemAttempts; attempt++) {
        if (attempt > 1) {
          await itemLogger.log("INFO", `Retrying account task (attempt ${attempt}/${maxItemAttempts}) after closing browser...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }

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
            if (loginResult.reason === "TRANSIENT") {
              throw new Error(`Gmail login failed: TRANSIENT - ${loginResult.detail}`);
            } else {
              // Hard error (e.g. wrong password, locked) — record and do not retry
              updateItemInJobFile(item.id, (it) => {
                it.status = "FAILED";
                it.error = `${loginResult.reason}: ${loginResult.detail}`;
                it.updatedAt = new Date().toISOString();
              });
              break;
            }
          }

          // Perform the 2FA change
          const result = await change2FA(page, {
            loginEmail: item.email,
            loginPassword: item.password,
            totpSecret: item.oldSecret || null
          }, itemLogger);

          if (result.success) {
            updateItemInJobFile(item.id, (it) => {
              it.status = "SUCCESS";
              it.newSecret = result.newTotpSecret;
              it.updatedAt = new Date().toISOString();
            });
            success = true;
          } else {
            // Hard error in change2FA — record and do not retry
            updateItemInJobFile(item.id, (it) => {
              it.status = "FAILED";
              it.error = `${result.reason}: ${result.detail}`;
              it.updatedAt = new Date().toISOString();
            });
          }
          break;

        } catch (err: any) {
          const errMsg = err.message || String(err);
          await itemLogger.log("WARN", `Attempt ${attempt}/${maxItemAttempts} failed: ${errMsg}`);
          
          if (attempt === maxItemAttempts) {
            updateItemInJobFile(item.id, (it) => {
              it.status = "FAILED";
              it.error = errMsg;
              it.updatedAt = new Date().toISOString();
            });
          }
        } finally {
          stopHeartbeat?.();
          await browser.disconnect().catch(() => {});
          if (profileId) {
            await adspower.closeProfile(profileId).catch(() => {});
            await pool.release(profileId, workerId).catch(() => {});
          }
          await pool.releaseAccount(item.email, workerId).catch(() => {});
        }

        if (success) break;
      }
    }
  }

  // Run 2 worker loops concurrently
  await Promise.all([worker(), worker()]);

  // Mark job as completed
  const finalJobData = readJob();
  const allDone = finalJobData.items.every(it => it.status === "SUCCESS" || it.status === "FAILED");
  finalJobData.status = allDone ? "COMPLETED" : "FAILED";
  finalJobData.updatedAt = new Date().toISOString();
  writeJob(finalJobData);
}
