-- Keep the console subscription list from scanning and sorting the full table.
CREATE INDEX "Subscription_createdAt_idx" ON "Subscription"("createdAt");
CREATE INDEX "Subscription_status_createdAt_idx" ON "Subscription"("status", "createdAt");
