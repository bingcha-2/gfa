# Design Spec: Bulk 2FA Concurrency inside GFA Worker

## Context
Currently, the GFA bulk 2FA worker ([bulk-2fa.processor.ts](file:///c:/Users/Administrator/Desktop/GFA/apps/worker/src/processors/bulk-2fa.processor.ts)) processes accounts inside a bulk job sequentially in a `for` loop. This takes a long time for large jobs. We want to process accounts in parallel with a concurrency limit of 2 (i.e. running 2 browser windows at the same time).

## Design Choice: Promise-based Concurrency Pool
We will implement a simple concurrent worker pool using `Promise.all` inside `processBulk2FA`. 

### Key Challenges & Solutions
1. **JSON File Race Conditions**: 
   - Multiple parallel executions will attempt to update the same JSON file `job_${jobId}.json` containing item states.
   - **Solution**: We will perform all reads, updates, and writes synchronously back-to-back using a helper function `updateItemInJobFile()`. Since Node.js is single-threaded, a synchronous read-modify-write block is atomic and prevents race conditions.
2. **AdsPower Browser & Profile Locking**: 
   - GFA's `BrowserPool` already tracks lock status by account email and profile ID in Redis, making parallel execution of browser sessions completely thread-safe.
3. **Queue Item Tracking**: 
   - A single shared cursor (index) will track the next pending account item to process.

## Proposed Changes

### [bulk-2fa.processor.ts](file:///c:/Users/Administrator/Desktop/GFA/apps/worker/src/processors/bulk-2fa.processor.ts)
- Replace the serial `for` loop with a parallel worker runner:
  ```typescript
  let nextIndex = 0;
  
  async function worker() {
    while (true) {
      let currentIndex = -1;
      let item: BulkJobItem | undefined;
      
      // Get the next item to process synchronously
      if (nextIndex < items.length) {
        currentIndex = nextIndex++;
        const currentJobData = readJob();
        item = currentJobData.items[currentIndex];
      }
      
      if (!item) break; // Finished all items
      if (item.status === "SUCCESS" || item.status === "FAILED") continue;
      
      // Update item state to RUNNING atomically
      updateItemInJobFile(item.id, (it) => {
        it.status = "RUNNING";
        it.updatedAt = new Date().toISOString();
      });
      
      // Process item (login + 2FA setup)
      // On success/fail: write outcome back atomically via updateItemInJobFile
    }
  }
  
  // Run 2 workers concurrently
  await Promise.all([worker(), worker()]);
  ```

---

## Verification Plan

### Automated Verification
- Compile the worker package: `pnpm --filter @gfa/worker build`
- Run worker unit tests: `pnpm --filter @gfa/worker test -- gmail-login`

### Manual Verification
- Start GFA dev server.
- Submit or resume the active bulk job `job_1780889232341`.
- Verify in dev server console logs that two account logs (with two different email IDs) execute and log statements in parallel (opening two profiles concurrently).
