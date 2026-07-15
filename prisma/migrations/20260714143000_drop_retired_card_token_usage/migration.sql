-- CardUsageHourly has been the only runtime usage store since 2026-06-16.
-- The request-level CardTokenUsage table was deliberately retained for one
-- transition cycle and is now safe to remove. SQLite drops its indexes with it.
DROP TABLE IF EXISTS "CardTokenUsage";
