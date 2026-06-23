-- RequestLog 增 sessionId 列:X-Claude-Code-Session-Id(每会话 id),
-- 用于按母号/客户统计"每分钟最多开多少 session"。老客户端不上报时为空字符串。

-- AlterTable
ALTER TABLE "RequestLog" ADD COLUMN "sessionId" TEXT NOT NULL DEFAULT '';
