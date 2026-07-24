-- Trial subscriptions are first-class subscriptions so the existing expiry,
-- device and entitlement paths remain authoritative.
ALTER TABLE "Subscription" ADD COLUMN "isTrial" BOOLEAN NOT NULL DEFAULT false;

-- SQLite stores Prisma enums as TEXT; the generated client/schema constrains
-- the new TRIAL value while existing rows require no data rewrite.
