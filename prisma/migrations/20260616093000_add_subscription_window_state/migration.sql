-- Subscription.windowState stores persisted 5h/week rate-limit window snapshots.
-- Nullable SQLite TEXT column; no table rewrite, no data loss.
ALTER TABLE "Subscription" ADD COLUMN "windowState" TEXT;
