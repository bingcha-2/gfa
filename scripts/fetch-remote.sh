#!/bin/bash
# ============================================================
# 从远程 bcai.site 拉取数据并导入本地数据库
# 使用前：关闭代理(Surge/ClashX等)，确保可以直连
# ============================================================

set -e

TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbW44c3loam0wMDAweGs3b3RxNHVoNnhxIiwiZW1haWwiOiJhZG1pbkBnZmEubG9jYWwiLCJyb2xlIjoiQURNSU4iLCJpYXQiOjE3NzU3Mjc2NjgsImV4cCI6MTc3NTc3MDg2OH0.ZEUXPly2uhrdDXnjAdjopdBS7bbyKCUWlM89x3a5MA8"
BASE_URL="https://bcai.site/api/proxy"
DATA_DIR="$(dirname "$0")/remote-data"

mkdir -p "$DATA_DIR"

echo "📂 数据保存目录: $DATA_DIR"
echo ""

# ── 1. 获取母号 (Accounts) ──
echo "⏳ [1/3] 获取母号数据..."
curl -s "$BASE_URL/accounts" \
  -H 'accept: application/json' \
  -b "gfa.console.token=$TOKEN" \
  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' \
  -o "$DATA_DIR/accounts.json"
ACC_SIZE=$(wc -c < "$DATA_DIR/accounts.json" | tr -d ' ')
echo "✅ 母号数据已保存: accounts.json ($ACC_SIZE bytes)"

# ── 2. 获取家庭组 (Family Groups，含成员) ──
echo "⏳ [2/3] 获取家庭组数据..."
curl -s "$BASE_URL/family-groups" \
  -H 'accept: application/json' \
  -b "gfa.console.token=$TOKEN" \
  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' \
  -o "$DATA_DIR/family-groups.json"
FG_SIZE=$(wc -c < "$DATA_DIR/family-groups.json" | tr -d ' ')
echo "✅ 家庭组数据已保存: family-groups.json ($FG_SIZE bytes)"

# ── 3. 获取兑换码 (Redeem Codes) ──
echo "⏳ [3/3] 获取兑换码数据..."
curl -s "$BASE_URL/redeem-codes?pageSize=9999" \
  -H 'accept: application/json' \
  -b "gfa.console.token=$TOKEN" \
  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' \
  -o "$DATA_DIR/redeem-codes.json"
RC_SIZE=$(wc -c < "$DATA_DIR/redeem-codes.json" | tr -d ' ')
echo "✅ 兑换码数据已保存: redeem-codes.json ($RC_SIZE bytes)"

echo ""
echo "========================================="
echo "📊 数据拉取完成！文件列表："
ls -lh "$DATA_DIR"/*.json
echo "========================================="
echo ""
echo "下一步：执行 node scripts/import-remote-data.mjs 导入本地数据库"
