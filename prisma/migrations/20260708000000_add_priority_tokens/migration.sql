-- CardUsageHourly 新增「快速档」计费 token 列 priorityTokens。
-- 客户端对走 Codex 快速档(service_tier=priority)的生成请求,随用量上报回传 serviceTier;
-- 服务端在小时聚合里把这些请求的计费 token 累加进本列,供后台查 fast 用量占比
-- (priorityTokens / totalTokens),并为将来「按 fast 计费」留数据。历史行无此数据,默认 0。

-- AlterTable
ALTER TABLE "CardUsageHourly" ADD COLUMN "priorityTokens" INTEGER NOT NULL DEFAULT 0;
