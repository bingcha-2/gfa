# Bulk 2FA Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow processing two accounts in parallel within a bulk 2FA task, speeding up the rotation process.

**Architecture:** Use a Promise-based worker pool (concurrency: 2) inside `processBulk2FA`. Track item selection using a shared index, and prevent JSON file write race conditions by performing read-modify-writes synchronously in single-threaded Node.js.

**Tech Stack:** TypeScript, Node.js filesystem API (fs), BullMQ.

---

### Task 1: Update bulk2faWorker Concurrency Configuration

**Files:**
- Modify: [index.ts](file:///c:/Users/Administrator/Desktop/GFA/apps/worker/src/index.ts:193-202)

- [ ] **Step 1: Modify worker concurrency setting**

Update `bulk2faWorker` in `apps/worker/src/index.ts` to allow concurrency of 2:
```typescript
const bulk2faWorker = new Worker<{ jobId: string }>(
  QUEUE_NAMES.bulk2fa,
  (job) => processBulk2FA(job, deps),
  {
    connection,
    concurrency: 2,
    lockDuration: 1800_000,
    stalledInterval: 120_000,
  }
);
```

- [ ] **Step 2: Commit**
```bash
git add apps/worker/src/index.ts
git commit -m "feat: increase bulk2faWorker concurrency to 2"
```

---

### Task 2: Implement Concurrent Processing in processBulk2FA

**Files:**
- Modify: [bulk-2fa.processor.ts](file:///c:/Users/Administrator/Desktop/GFA/apps/worker/src/processors/bulk-2fa.processor.ts)

- [ ] **Step 1: Replace item loop with concurrent workers and atomic JSON updates**

Replace the sequential `for` loop in `apps/worker/src/processors/bulk-2fa.processor.ts` starting from line 66 with a parallel runner:
```typescript
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

      // Select next item synchronously
      if (nextIndex < items.length) {
        currentIndex = nextIndex++;
        const currentJob = readJob();
        item = currentJob.items[currentIndex];
      }

      if (!item) break; // No more items
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
          const acquired = await pool.acquireAndOpen(workerId, item.email, adspower);
          profileId = acquired.profileId;
          stopHeartbeat = pool.startHeartbeat(profileId, item.email, workerId);

          const page = await browser.connect(acquired.debugUrl);

          const loginResult = await gmailLogin(page, {
            loginEmail: item.email,
            loginPassword: item.password,
            totpSecret: item.oldSecret || null,
            recoveryEmail: item.recoveryEmail || null
          }, itemLogger, {
            manualChallengeWaitMs: 300000,
            skipCaptchaManualWait: true,
            skipPhoneChallengeManualWait: true
          });

          if (!loginResult.success) {
            if (loginResult.reason === "TRANSIENT") {
              throw new Error(`Gmail login failed: TRANSIENT - ${loginResult.detail}`);
            } else {
              updateItemInJobFile(item.id, (it) => {
                it.status = "FAILED";
                it.error = `${loginResult.reason}: ${loginResult.detail}`;
                it.updatedAt = new Date().toISOString();
              });
              break;
            }
          }

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

  // Run two worker loops concurrently
  await Promise.all([worker(), worker()]);

  // Mark job as completed/failed based on terminal states
  const finalJobData = readJob();
  const allDone = finalJobData.items.every(it => it.status === "SUCCESS" || it.status === "FAILED");
  finalJobData.status = allDone ? "COMPLETED" : "FAILED";
  finalJobData.updatedAt = new Date().toISOString();
  writeJob(finalJobData);
```

- [ ] **Step 2: Commit**
```bash
git add apps/worker/src/processors/bulk-2fa.processor.ts
git commit -m "feat: parallelize bulk 2FA item processing with concurrency of 2"
```

---

### Task 3: Build & Validation

- [ ] **Step 1: Build the worker package**

Run: `pnpm --filter @gfa/worker build`
Expected: Builds successfully with exit code 0.

- [ ] **Step 2: Run worker unit tests**

Run: `pnpm --filter @gfa/worker run test -- gmail-login`
Expected: Unit tests in `src/__tests__/gmail-login.unit.spec.ts` pass successfully.

- [ ] **Step 3: Commit all remaining changes**
```bash
git commit -a -m "test: verify build and unit tests pass with concurrency updates"
```
