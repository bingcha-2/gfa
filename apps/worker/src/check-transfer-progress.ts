/**
 * Transfer batch progress checker.
 *
 * Called after each remove/invite task completes (SUCCESS or FAILED_FINAL).
 * When all sibling tasks of the current phase are done:
 *   - REMOVE phase complete → create invite tasks and advance to INVITING
 *   - INVITE phase complete → mark batch COMPLETED or PARTIALLY_FAILED
 *
 * This is a lightweight callback — no polling, no new queues.
 */

import { PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";
import { JOB_DEFAULTS } from "@gfa/shared";

const TERMINAL_STATUSES = new Set([
  "SUCCESS",
  "INVITE_SENT",
  "FAILED_FINAL",
  "MANUAL_REVIEW",
  "CANCELLED",
]);

export async function checkTransferBatchProgress(
  prisma: PrismaClient,
  taskId: string,
  inviteQueue: Queue
): Promise<void> {
  // 1. Check if this task belongs to a transfer batch
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { transferBatchId: true, type: true, status: true },
  });

  if (!task?.transferBatchId) return; // Not a transfer task — no-op

  const batchId = task.transferBatchId;

  // 2. Count sibling tasks of the same type in this batch
  const siblings = await prisma.task.findMany({
    where: { transferBatchId: batchId, type: task.type },
    select: { status: true, payload: true },
  });

  const allDone = siblings.every((t) => TERMINAL_STATUSES.has(t.status));
  if (!allDone) return; // Other siblings still running

  // 3. REMOVE phase complete → trigger INVITE phase
  if (task.type === "REMOVE_MEMBER") {
    const successEmails = siblings
      .filter((t) => t.status === "SUCCESS")
      .map((t) => {
        try { return JSON.parse(t.payload).memberEmail; }
        catch { return null; }
      })
      .filter(Boolean) as string[];

    const failedCount = siblings.filter((t) => t.status !== "SUCCESS").length;

    if (successEmails.length === 0) {
      // All removes failed — batch is FAILED
      await prisma.transferBatch.update({
        where: { id: batchId },
        data: {
          phase: "FAILED",
          removedCount: 0,
          removeFailedCount: failedCount,
        },
      });
      console.log(`[transfer] Batch ${batchId} → FAILED (all removes failed)`);
      return;
    }

    // Update batch to INVITING phase
    const batch = await prisma.transferBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch) return;

    // Fetch target group info
    const targetGroup = await prisma.familyGroup.findUnique({
      where: { id: batch.targetGroupId },
      select: { id: true, accountId: true, availableSlots: true },
    });
    if (!targetGroup) {
      await prisma.transferBatch.update({
        where: { id: batchId },
        data: {
          phase: "FAILED",
          removedCount: successEmails.length,
          removeFailedCount: failedCount,
          errorDetail: JSON.stringify([{ email: "*", error: "TARGET_GROUP_NOT_FOUND" }]),
        },
      });
      return;
    }

    // Decision #3: allow partial invite — invite as many as slots allow
    const invitableEmails = successEmails.slice(0, targetGroup.availableSlots);
    const unplaceableEmails = successEmails.slice(targetGroup.availableSlots);

    // Record existing errors from remove phase
    const existingErrors: { email: string; error: string }[] = [];
    if (unplaceableEmails.length > 0) {
      unplaceableEmails.forEach((e) =>
        existingErrors.push({ email: e, error: "TARGET_GROUP_FULL" })
      );
    }

    await prisma.transferBatch.update({
      where: { id: batchId },
      data: {
        phase: invitableEmails.length > 0 ? "INVITING" : "PARTIALLY_FAILED",
        removedCount: successEmails.length,
        removeFailedCount: failedCount,
        errorDetail: existingErrors.length > 0 ? JSON.stringify(existingErrors) : batch.errorDetail,
      },
    });

    if (invitableEmails.length === 0) {
      console.log(`[transfer] Batch ${batchId} → PARTIALLY_FAILED (no slots in target group)`);
      return;
    }

    // Reserve slots in target group
    await prisma.familyGroup.update({
      where: { id: targetGroup.id },
      data: { availableSlots: { decrement: invitableEmails.length } },
    });

    // Create invite tasks
    for (const email of invitableEmails) {
      const inviteTask = await prisma.task.create({
        data: {
          type: "INVITE_MEMBER",
          familyGroupId: targetGroup.id,
          accountId: targetGroup.accountId,
          transferBatchId: batchId,
          payload: JSON.stringify({
            familyGroupId: targetGroup.id,
            accountId: targetGroup.accountId,
            userEmail: email,
          }),
        },
      });

      try {
        await inviteQueue.add(
          "invite-member",
          {
            taskId: inviteTask.id,
            familyGroupId: targetGroup.id,
            accountId: targetGroup.accountId,
            userEmail: email,
          },
          {
            ...JOB_DEFAULTS,
            jobId: `transfer-invite:${batchId}:${email}`,
          }
        );
      } catch (err) {
        console.error(`[transfer] Failed to enqueue invite for ${email}:`, err);
        // Release slot, delete orphan task
        await prisma.familyGroup.update({
          where: { id: targetGroup.id },
          data: { availableSlots: { increment: 1 } },
        }).catch(() => {});
        await prisma.task.delete({ where: { id: inviteTask.id } }).catch(() => {});
      }
    }

    console.log(
      `[transfer] Batch ${batchId} → INVITING (${invitableEmails.length} invites queued, ${unplaceableEmails.length} unplaceable)`
    );
    return;
  }

  // 4. INVITE phase complete → finalize batch
  if (task.type === "INVITE_MEMBER") {
    const inviteSuccess = siblings.filter(
      (t) => t.status === "SUCCESS" || t.status === "INVITE_SENT"
    ).length;
    const inviteFailed = siblings.filter(
      (t) => !["SUCCESS", "INVITE_SENT"].includes(t.status)
    ).length;

    const batch = await prisma.transferBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch) return;

    const hasFailures = batch.removeFailedCount > 0 || inviteFailed > 0;
    // Also check if there were unplaceable members (already in errorDetail)
    const existingErrors = batch.errorDetail ? JSON.parse(batch.errorDetail) : [];
    const hasUnplaceable = existingErrors.some(
      (e: { error: string }) => e.error === "TARGET_GROUP_FULL"
    );

    await prisma.transferBatch.update({
      where: { id: batchId },
      data: {
        phase: hasFailures || hasUnplaceable ? "PARTIALLY_FAILED" : "COMPLETED",
        invitedCount: inviteSuccess,
        inviteFailedCount: inviteFailed,
      },
    });

    console.log(
      `[transfer] Batch ${batchId} → ${hasFailures || hasUnplaceable ? "PARTIALLY_FAILED" : "COMPLETED"} (invited: ${inviteSuccess}, failed: ${inviteFailed})`
    );
  }
}
