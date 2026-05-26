#!/bin/bash
# ============================================================================
# dev-local.sh — 本地一键拉起 Remote Token Server + 冰茶 AI 客户端
#
# 用法:
#   ./dev-local.sh              # 同时启动服务端 + 客户端
#   ./dev-local.sh server       # 仅启动服务端 (remote-token-server)
#   ./dev-local.sh client       # 仅启动客户端 (wails dev)
#   LOCAL=1 ./dev-local.sh      # 客户端连本地服务端 (自动 patch API_BASE)
# ============================================================================

set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

# ── 颜色 ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

# ── 路径 ──
ROSETTA_DIR="$ROOT/apps/gfa-extension/bundled-rosetta"
REMOTE_TOKEN_DIR="$ROSETTA_DIR/remote-token-server"
WAILS_DIR="$ROOT/apps/bcai-wails"
DATA_DIR="$HOME/Library/Application Support/Antigravity/rosetta"
LEASER_GO="$WAILS_DIR/leaser.go"

# ── PID 追踪 ──
SERVER_PID=""
CLIENT_PID=""
PATCHED=false

# ── 清理函数 ──
cleanup() {
  echo ""
  echo -e "${YELLOW}[shutdown] 正在停止所有服务...${NC}"

  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo -e "${DIM}[shutdown] 停止 remote-token-server (PID $SERVER_PID)${NC}"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi

  if [ -n "$CLIENT_PID" ] && kill -0 "$CLIENT_PID" 2>/dev/null; then
    echo -e "${DIM}[shutdown] 停止 wails dev (PID $CLIENT_PID)${NC}"
    kill "$CLIENT_PID" 2>/dev/null || true
    wait "$CLIENT_PID" 2>/dev/null || true
  fi

  # 恢复 leaser.go (如果被 patch 过)
  if [ "$PATCHED" = true ] && [ -f "$LEASER_GO.bak" ]; then
    echo -e "${DIM}[shutdown] 恢复 leaser.go 原始 API_BASE${NC}"
    mv "$LEASER_GO.bak" "$LEASER_GO"
  fi

  echo -e "${GREEN}[shutdown] 已全部停止${NC}"
  exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# ── 环境检查 ──
check_prerequisites() {
  echo -e "${BOLD}${CYAN}═══ 环境检查 ═══${NC}"
  local ok=true

  # Node.js
  if command -v node &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"
  else
    echo -e "  ${RED}✗${NC} Node.js 未安装"
    ok=false
  fi

  # Go
  if command -v go &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Go $(go version | awk '{print $3}')"
  else
    echo -e "  ${RED}✗${NC} Go 未安装"
    ok=false
  fi

  # Wails
  if command -v wails &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Wails $(wails version 2>/dev/null | head -1)"
  else
    echo -e "  ${RED}✗${NC} Wails 未安装 (go install github.com/wailsapp/wails/v2/cmd/wails@latest)"
    ok=false
  fi

  if [ "$ok" = false ]; then
    echo -e "\n${RED}请先安装缺失的依赖${NC}"
    exit 1
  fi
  echo ""
}

# ── 初始化数据目录 ──
init_data_dir() {
  echo -e "${BOLD}${CYAN}═══ 初始化数据目录 ═══${NC}"

  # 创建数据目录
  if [ ! -d "$DATA_DIR" ]; then
    mkdir -p "$DATA_DIR/logs" "$DATA_DIR/cache"
    echo -e "  ${GREEN}✓${NC} 创建 $DATA_DIR"
  else
    echo -e "  ${DIM}✓ 数据目录已存在${NC}"
  fi

  # proxy.config.json
  if [ ! -f "$DATA_DIR/proxy.config.json" ]; then
    cat > "$DATA_DIR/proxy.config.json" << 'CONFIGEOF'
{
  "remoteTokenServer": {
    "host": "0.0.0.0",
    "port": 60700,
    "secret": "",
    "leaseTtlMs": 2700000,
    "affinityTtlMs": 7200000,
    "maxConcurrentPerAccount": 1
  }
}
CONFIGEOF
    echo -e "  ${GREEN}✓${NC} 创建 proxy.config.json (默认配置)"
  else
    echo -e "  ${DIM}✓ proxy.config.json 已存在${NC}"
  fi

  # accounts.json
  if [ ! -f "$DATA_DIR/accounts.json" ]; then
    echo '[]' > "$DATA_DIR/accounts.json"
    echo -e "  ${YELLOW}⚠${NC} 创建空 accounts.json — ${YELLOW}需要添加 Google 账号才能租号${NC}"
    echo -e "    ${DIM}从生产服务器拷贝 accounts.json 到: $DATA_DIR/accounts.json${NC}"
  else
    local count
    count=$(node -e "try{const d=require('$DATA_DIR/accounts.json');console.log(Array.isArray(d)?d.length:(d.accounts||[]).length)}catch{console.log(0)}" 2>/dev/null || echo "?")
    echo -e "  ${GREEN}✓${NC} accounts.json ($count 个账号)"
  fi

  # access-keys.json
  if [ ! -f "$DATA_DIR/access-keys.json" ]; then
    cat > "$DATA_DIR/access-keys.json" << 'KEYSEOF'
{
  "keys": [
    {
      "id": "local-dev",
      "name": "本地开发卡密",
      "status": "active",
      "durationMs": 0,
      "windowMs": 18000000,
      "windowLimit": 0,
      "createdAt": ""
    }
  ]
}
KEYSEOF
    echo -e "  ${GREEN}✓${NC} 创建 access-keys.json (本地开发 key: ${CYAN}local-dev${NC})"
  else
    echo -e "  ${DIM}✓ access-keys.json 已存在${NC}"
  fi

  echo ""
}

# ── 安装 bundled-rosetta 依赖 ──
install_rosetta_deps() {
  if [ ! -d "$ROSETTA_DIR/node_modules" ] || [ ! -d "$ROSETTA_DIR/node_modules/better-sqlite3" ]; then
    echo -e "${BOLD}${CYAN}═══ 安装 bundled-rosetta 依赖 ═══${NC}"
    (cd "$ROSETTA_DIR" && npm install --no-audit --no-fund 2>&1 | tail -3)
    echo -e "  ${GREEN}✓${NC} 依赖安装完成"
    echo ""
  fi
}

# ── Patch 客户端 API_BASE 指向本地 ──
patch_client_local() {
  if [ "${LOCAL:-}" = "1" ]; then
    echo -e "${BOLD}${CYAN}═══ Patch 客户端 → 本地服务端 ═══${NC}"
    if grep -q 'const API_BASE = "https://bcai.site/remote-token"' "$LEASER_GO"; then
      cp "$LEASER_GO" "$LEASER_GO.bak"
      sed -i '' 's|const API_BASE = "https://bcai.site/remote-token"|const API_BASE = "http://127.0.0.1:60700"|' "$LEASER_GO"
      PATCHED=true
      echo -e "  ${GREEN}✓${NC} API_BASE → ${CYAN}http://127.0.0.1:60700${NC}"
      echo -e "  ${DIM}退出时自动恢复原始值${NC}"
    else
      echo -e "  ${YELLOW}⚠${NC} leaser.go 中未找到预期的 API_BASE，跳过 patch"
    fi
    echo ""
  fi
}

# ── 启动 Remote Token Server ──
start_server() {
  echo -e "${BOLD}${MAGENTA}═══ 启动 Remote Token Server ═══${NC}"
  echo -e "  ${DIM}端口: 60700${NC}"
  echo -e "  ${DIM}数据: $DATA_DIR${NC}"
  echo -e "  ${DIM}日志: $DATA_DIR/logs/remote-token-server.log${NC}"
  echo ""

  export ROSETTA_DATA_DIR="$DATA_DIR"
  (cd "$ROSETTA_DIR" && node remote-token-server/index.js 2>&1 | while IFS= read -r line; do
    echo -e "${MAGENTA}[server]${NC} $line"
  done) &
  SERVER_PID=$!

  # 等待服务端启动
  echo -e "${DIM}[server] 等待启动...${NC}"
  local retries=0
  while [ $retries -lt 20 ]; do
    if curl -s http://127.0.0.1:60700/health >/dev/null 2>&1; then
      echo -e "${GREEN}[server] ✓ Remote Token Server 已启动${NC}"
      echo ""
      return 0
    fi
    sleep 0.5
    retries=$((retries + 1))
  done

  echo -e "${YELLOW}[server] ⚠ 启动超时，但继续运行...${NC}"
  echo ""
}

# ── 启动冰茶 AI 客户端 ──
start_client() {
  echo -e "${BOLD}${CYAN}═══ 启动冰茶 AI 客户端 (wails dev) ═══${NC}"
  if [ "${LOCAL:-}" = "1" ]; then
    echo -e "  ${DIM}模式: 连接本地服务端 (127.0.0.1:60700)${NC}"
  else
    echo -e "  ${DIM}模式: 连接远程 bcai.site${NC}"
  fi
  echo ""

  (cd "$WAILS_DIR" && wails dev 2>&1 | while IFS= read -r line; do
    echo -e "${CYAN}[client]${NC} $line"
  done) &
  CLIENT_PID=$!
}

# ── 打印启动摘要 ──
print_banner() {
  echo -e ""
  echo -e "${GREEN}${BOLD}┌──────────────────────────────────────────────────────────┐${NC}"
  echo -e "${GREEN}│${NC}${BOLD}  🍵  冰茶 AI 本地开发环境                                ${NC}${GREEN}│${NC}"
  echo -e "${GREEN}├──────────────────────────────────────────────────────────┤${NC}"

  if [ -n "$SERVER_PID" ]; then
    echo -e "${GREEN}│${NC}  ${DIM}Remote Token Server${NC}   ${CYAN}http://127.0.0.1:60700/status${NC}"
  fi

  if [ -n "$CLIENT_PID" ]; then
    if [ "${LOCAL:-}" = "1" ]; then
      echo -e "${GREEN}│${NC}  ${DIM}冰茶 AI 客户端${NC}       ${CYAN}连接本地 :60700${NC}"
    else
      echo -e "${GREEN}│${NC}  ${DIM}冰茶 AI 客户端${NC}       ${CYAN}连接远程 bcai.site${NC}"
    fi
  fi

  echo -e "${GREEN}├──────────────────────────────────────────────────────────┤${NC}"
  echo -e "${GREEN}│${NC}  ${DIM}卡密 (access key)${NC}     ${YELLOW}local-dev${NC}"
  echo -e "${GREEN}│${NC}  ${DIM}数据目录${NC}              ${DIM}$DATA_DIR${NC}"
  echo -e "${GREEN}│${NC}  ${DIM}Ctrl+C${NC}                ${DIM}停止所有服务${NC}"
  echo -e "${GREEN}└──────────────────────────────────────────────────────────┘${NC}"
  echo ""
}

# ── Main ──
main() {
  local mode="${1:-all}"

  check_prerequisites
  init_data_dir
  install_rosetta_deps

  case "$mode" in
    server)
      start_server
      print_banner
      wait "$SERVER_PID" 2>/dev/null || true
      ;;
    client)
      patch_client_local
      start_client
      print_banner
      wait "$CLIENT_PID" 2>/dev/null || true
      ;;
    all|*)
      patch_client_local
      start_server
      start_client
      print_banner
      # 等待任一进程退出
      wait -n "$SERVER_PID" "$CLIENT_PID" 2>/dev/null || wait "$SERVER_PID" 2>/dev/null || true
      ;;
  esac
}

main "$@"
