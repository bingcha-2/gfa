-- 余额抵扣:PlanOrder 记录本单从 Customer.creditCents 抵扣的金额(分)。
-- 失败/取消/超时/退款时按此回补余额。PayChannel 新增 CREDIT(全额抵扣单)无需 DDL —— SQLite enum 即 TEXT。
ALTER TABLE "PlanOrder" ADD COLUMN "creditAppliedCents" INTEGER NOT NULL DEFAULT 0;
