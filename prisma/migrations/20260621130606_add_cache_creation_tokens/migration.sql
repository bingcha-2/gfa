-- CardUsageHourly 新增缓存写列 cacheCreationTokens。
-- 此前服务端把 input 归一为 gross(net+cache_creation+cache_read),cache_creation 混入 input 无法还原
-- → USD/今日用量里的「缓存写」恒为 0、缓存读还被按满额 input 单价计。新增此列后由 tracker 单独累加,
-- portal USD 与今日用量得以对齐客户端口径。历史行无此数据,默认 0(历史 USD 仍少算缓存写,不回填)。

-- AlterTable
ALTER TABLE "CardUsageHourly" ADD COLUMN "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0;
