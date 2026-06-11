-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "activatedFromOrderId" TEXT;

-- CreateIndex
CREATE INDEX "Subscription_activatedFromOrderId_idx" ON "Subscription"("activatedFromOrderId");
