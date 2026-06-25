#!/usr/bin/env bash
# Claude 出口 TLS 指纹自检 —— Claude Code 升级后跑一下,30 秒确认是否需要更新指纹 spec。
#
#   bash scripts/verify-claude-fingerprint.sh
#
# 原理见 apps/app/fingerprint_verify_test.go。需本机装有 `claude`(Claude Code CLI)。
# 输出 ✅ = 当前 claudeCodeClientHelloSpec 仍贴合真客户端,无需动;
# 输出 ❌ = 漂移了,按打印的「真客户端」明细更新 apps/app/claude_egress.go 后重跑。
set -euo pipefail
cd "$(dirname "$0")/../apps/app"
exec env VERIFY_FP=1 go test -run TestClaudeFingerprintDrift -count=1 -v ./
