-- CardUsageHourly 新增反代命中计数列 reverseProxyHits。
-- 客户端代理(detectClaudeCodeClient)判定某次 /v1/messages 不是真 Claude Code 客户端
-- (缺固定 system 前缀=很可能被反代/换了别的客户端再分发)时,随用量上报回传 clientFlag;
-- 服务端在小时聚合里把命中数累加进本列,供后台按卡/客户/号查询「哪张卡在反代」。
-- 历史行无此数据,默认 0。

-- AlterTable
ALTER TABLE "CardUsageHourly" ADD COLUMN "reverseProxyHits" INTEGER NOT NULL DEFAULT 0;
