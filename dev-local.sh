#!/bin/bash
# ============================================================================
# dev-local.sh — 一键拉起全部服务
#
# 用法:
#   ./dev-local.sh              # 启动全部: API + Web + Worker + Wails 客户端 (连本地)
#   ./dev-local.sh server       # 仅后端 (API + Web + Worker, 即 pnpm dev)
#   ./dev-local.sh client       # 仅 Wails 客户端（连本地服务端）
#   ./dev-local.sh remote       # 仅 Wails 客户端（连远端 bcai.site）
#   ./dev-local.sh build        # 本地编译客户端二进制
#
#   EPAY_TUNNEL=0 ./dev-local.sh server   # 关掉 ngrok 穿透（默认开启，自动把 epay 回调指到本地）
# ============================================================================

set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

# 默认连本地
export LOCAL="${LOCAL:-1}"

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
API_DIR="$ROOT/apps/server"
WAILS_DIR="$ROOT/apps/app"
DATA_DIR="$HOME/Library/Application Support/Antigravity/rosetta"
WAILS_BIN="${WAILS_BIN:-$(command -v wails 2>/dev/null || echo "$HOME/go/bin/wails")}"

# ── PID 追踪 ──
SERVER_PID=""
CLIENT_PID=""
NGROK_PID=""

# ── 环境检查 ──
check_prerequisites() {
  local mode="$1"
  echo -e "${BOLD}${CYAN}═══ 环境检查 ═══${NC}"
  local ok=true

  if command -v node &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"
  else
    echo -e "  ${RED}✗${NC} Node.js 未安装"
    ok=false
  fi

  if [ "$mode" != "server" ]; then
    if command -v go &>/dev/null; then
      echo -e "  ${GREEN}✓${NC} Go $(go version | awk '{print $3}')"
    else
      echo -e "  ${RED}✗${NC} Go 未安装"
      ok=false
    fi

    if [ -x "$WAILS_BIN" ]; then
      echo -e "  ${GREEN}✓${NC} Wails ($WAILS_BIN)"
    else
      echo -e "  ${YELLOW}!${NC} Wails 未找到，尝试自动安装..."
      go install github.com/wailsapp/wails/v2/cmd/wails@latest 2>&1
      WAILS_BIN="$HOME/go/bin/wails"
      if [ -x "$WAILS_BIN" ]; then
        echo -e "  ${GREEN}✓${NC} Wails 安装成功 ($WAILS_BIN)"
      else
        echo -e "  ${RED}✗${NC} Wails 安装失败"
        ok=false
      fi
    fi
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

  if [ ! -d "$DATA_DIR" ]; then
    mkdir -p "$DATA_DIR/logs" "$DATA_DIR/cache"
    echo -e "  ${GREEN}✓${NC} 创建 $DATA_DIR"
  else
    echo -e "  ${DIM}✓ 数据目录已存在${NC}"
  fi

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

  if [ ! -f "$DATA_DIR/accounts.json" ]; then
    echo '[]' > "$DATA_DIR/accounts.json"
    echo -e "  ${YELLOW}⚠${NC} 创建空 accounts.json — ${YELLOW}需要添加 Google 账号才能租号${NC}"
  else
    local count
    count=$(node -e "try{const d=require('$DATA_DIR/accounts.json');console.log(Array.isArray(d)?d.length:(d.accounts||[]).length)}catch{console.log(0)}" 2>/dev/null || echo "?")
    echo -e "  ${GREEN}✓${NC} accounts.json ($count 个账号)"
  fi

  if [ ! -f "$DATA_DIR/codex-accounts.json" ]; then
    cat > "$DATA_DIR/codex-accounts.json" << 'CODEXEOF'
{
  "accounts": []
}
CODEXEOF
    echo -e "  ${YELLOW}⚠${NC} 创建空 codex-accounts.json — ${YELLOW}需要添加 Codex OAuth 账号才能代理 Codex${NC}"
  else
    local codex_count
    codex_count=$(node -e "try{const d=require('$DATA_DIR/codex-accounts.json');console.log(Array.isArray(d)?d.length:(d.accounts||[]).length)}catch{console.log(0)}" 2>/dev/null || echo "?")
    echo -e "  ${GREEN}✓${NC} codex-accounts.json ($codex_count 个账号)"
  fi

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

# ── 安装依赖 ──
install_deps() {
  if [ ! -d "$ROOT/node_modules" ] || [ ! -d "$API_DIR/node_modules" ]; then
    echo -e "${BOLD}${CYAN}═══ 安装依赖 ═══${NC}"
    (cd "$ROOT" && pnpm install 2>&1 | tail -5)
    echo -e "  ${GREEN}✓${NC} 依赖安装完成"
    echo ""
  fi
}

# ── 设置客户端环境变量 → 连本地服务端 ──
setup_client_env() {
  echo -e "${BOLD}${CYAN}═══ 客户端环境变量 → 本地服务端 ═══${NC}"

  export BCAI_API_BASE="http://127.0.0.1:3001/api/remote-token"
  export BCAI_CODEX_API_BASE="http://127.0.0.1:3001/api/remote-codex"
  export BCAI_ANTHROPIC_REMOTE_BASE="http://127.0.0.1:3001/api/remote-anthropic"
  export BCAI_UPDATE_URL="http://127.0.0.1:3000/updates/latest-wails.json"

  echo -e "  ${GREEN}✓${NC} BCAI_API_BASE  → ${CYAN}$BCAI_API_BASE${NC}"
  echo -e "  ${GREEN}✓${NC} BCAI_CODEX_API_BASE → ${CYAN}$BCAI_CODEX_API_BASE${NC}"
  echo -e "  ${GREEN}✓${NC} BCAI_ANTHROPIC_REMOTE_BASE → ${CYAN}$BCAI_ANTHROPIC_REMOTE_BASE${NC}"
  echo -e "  ${GREEN}✓${NC} BCAI_UPDATE_URL → ${CYAN}$BCAI_UPDATE_URL${NC}"
  echo -e "  ${DIM}无需修改源码，环境变量仅在本次运行生效${NC}"
  echo ""
}

# ── 清理函数 ──
cleanup() {
  echo ""
  echo -e "${YELLOW}[shutdown] 正在停止所有服务...${NC}"

  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo -e "${DIM}[shutdown] 停止后端服务 (PID $SERVER_PID)${NC}"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi

  if [ -n "$CLIENT_PID" ] && kill -0 "$CLIENT_PID" 2>/dev/null; then
    echo -e "${DIM}[shutdown] 停止 Wails 客户端 (PID $CLIENT_PID)${NC}"
    kill "$CLIENT_PID" 2>/dev/null || true
    wait "$CLIENT_PID" 2>/dev/null || true
  fi

  if [ -n "$NGROK_PID" ] && kill -0 "$NGROK_PID" 2>/dev/null; then
    echo -e "${DIM}[shutdown] 停止 ngrok (PID $NGROK_PID)${NC}"
    kill "$NGROK_PID" 2>/dev/null || true
  fi

  # 清理残留端口占用
  lsof -ti :3000 2>/dev/null | xargs kill -9 2>/dev/null || true
  lsof -ti :3001 2>/dev/null | xargs kill -9 2>/dev/null || true

  echo -e "${GREEN}[shutdown] 已全部停止${NC}"
  exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# ── ngrok 内网穿透：给 epay 回调一个公网地址（默认开启）──
# 关掉这次：EPAY_TUNNEL=0 ./dev-local.sh server
# 只有 NOTIFY 需要公网（epay 服务器要 POST 进来）；RETURN 走本地浏览器即可。
# 导出的两个变量会盖过 .env 里的生产值（@nestjs/config 不覆盖已存在的 process.env）。
start_epay_tunnel() {
  # 默认开启；这次想关掉用 EPAY_TUNNEL=0 ./dev-local.sh server
  [ "${EPAY_TUNNEL:-1}" = "1" ] || return 0

  if ! command -v ngrok >/dev/null 2>&1; then
    echo -e "${YELLOW}[epay] 未装 ngrok，跳过穿透（支付回调收不到）。装：brew install ngrok 并 ngrok config add-authtoken <token>${NC}"
    return 0
  fi

  echo -e "${BOLD}${CYAN}═══ 启动 ngrok 穿透（epay 回调用）═══${NC}"
  ngrok http "${API_PORT:-3001}" --log=stdout >/tmp/gfa-ngrok.log 2>&1 &
  NGROK_PID=$!

  local url="" tries=0
  while [ $tries -lt 30 ]; do
    # ngrok 进程已退出（多半没配 authtoken）→ 早退，别傻等满 30s
    kill -0 "$NGROK_PID" 2>/dev/null || break
    url=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null \
      | sed -n 's/.*"public_url":"\(https:[^"]*\)".*/\1/p' | head -1 || true)
    [ -n "$url" ] && break
    sleep 1
    tries=$((tries + 1))
  done

  if [ -z "$url" ]; then
    echo -e "${YELLOW}[epay] 未取到 ngrok 公网地址，跳过（看 /tmp/gfa-ngrok.log，多半是没配 authtoken）${NC}"
    return 0
  fi

  export EPAY_NOTIFY_URL="${url}/api/epay/notify"
  export EPAY_RETURN_URL="http://localhost:3000/account/billing"
  echo -e "  ${GREEN}✓${NC} EPAY_NOTIFY_URL = ${EPAY_NOTIFY_URL}"
  echo -e "  ${GREEN}✓${NC} EPAY_RETURN_URL = ${EPAY_RETURN_URL}"
  echo -e "  ${DIM}ngrok 面板: http://127.0.0.1:4040${NC}"
  echo ""
}

# ── 启动后端 (API + Web + Worker) ──
start_server() {
  echo -e "${BOLD}${MAGENTA}═══ 启动后端服务 (API + Web + Worker) ═══${NC}"
  echo -e "  ${DIM}API:    http://localhost:3001${NC}"
  echo -e "  ${DIM}Web:    http://localhost:3000${NC}"
  echo ""

  # 确保环境变量全部指向本地
  export DATABASE_URL="${DATABASE_URL:-file:./dev.db}"
  export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
  export API_PORT="${API_PORT:-3001}"
  export WEB_PORT="${WEB_PORT:-3000}"
  export API_BASE_URL="http://127.0.0.1:3001/api"
  export CORS_ALLOWED_ORIGINS="http://localhost:3000"
  export CONSOLE_COOKIE_SECURE=""
  export ADMIN_IP_ALLOWLIST=""
  export ADMIN_PATH_PREFIX="${ADMIN_PATH_PREFIX:-console}"
  export ROSETTA_DATA_DIR="$DATA_DIR"

  # 默认起 ngrok 并把 epay 回调指到本地（EPAY_TUNNEL=0 可关）
  start_epay_tunnel

  (cd "$ROOT" && pnpm dev 2>&1 | while IFS= read -r line; do
    echo -e "${MAGENTA}[server]${NC} $line"
  done) &
  SERVER_PID=$!

  echo -e "${DIM}[server] 等待 API + Web 启动...${NC}"
  local retries=0
  while [ $retries -lt 60 ]; do
    if curl -s http://127.0.0.1:3001/api/health >/dev/null 2>&1; then
      echo -e "${GREEN}[server] ✓ 后端服务已启动${NC}"
      echo ""
      return 0
    fi
    sleep 1
    retries=$((retries + 1))
  done

  echo -e "${YELLOW}[server] ⚠ 启动超时，但继续运行...${NC}"
  echo ""
}

# ── 启动 Wails 客户端 ──
start_client() {
  echo -e "${BOLD}${CYAN}═══ 启动冰茶 AI 客户端 (wails dev) ═══${NC}"
  echo -e "  ${DIM}模式: 连接本地服务端 (127.0.0.1:3001)${NC}"
  echo ""

  # 安装前端依赖
  if [ ! -d "$WAILS_DIR/frontend/node_modules" ]; then
    echo -e "${DIM}[client] 安装前端依赖...${NC}"
    (cd "$WAILS_DIR/frontend" && npm install 2>&1 | tail -3)
  fi

  (cd "$WAILS_DIR" && "$WAILS_BIN" dev 2>&1 | while IFS= read -r line; do
    echo -e "${CYAN}[client]${NC} $line"
  done) &
  CLIENT_PID=$!
}

# ── 打印启动摘要 ──
print_banner() {
  local target="${1:-local}"
  echo -e ""
  echo -e "${GREEN}${BOLD}┌──────────────────────────────────────────────────────────┐${NC}"

  if [ "$target" = "remote" ]; then
    echo -e "${GREEN}│${NC}${BOLD}  🍵  冰茶 AI 开发环境 (客户端连远端 bcai.site)           ${NC}${GREEN}│${NC}"
  else
    echo -e "${GREEN}│${NC}${BOLD}  🍵  冰茶 AI 本地开发环境 (全部本地，不连远端)           ${NC}${GREEN}│${NC}"
  fi

  echo -e "${GREEN}├──────────────────────────────────────────────────────────┤${NC}"

  if [ -n "$SERVER_PID" ]; then
    echo -e "${GREEN}│${NC}  ${DIM}Web Console${NC}          ${CYAN}http://localhost:3000/console${NC}"
    echo -e "${GREEN}│${NC}  ${DIM}API Health${NC}           ${CYAN}http://localhost:3001/api/health${NC}"
    echo -e "${GREEN}│${NC}  ${DIM}Remote Token${NC}         ${CYAN}http://localhost:3001/api/remote-token${NC}"
    echo -e "${GREEN}│${NC}  ${DIM}Remote Codex${NC}         ${CYAN}http://localhost:3001/api/remote-codex${NC}"
  fi

  if [ -n "$CLIENT_PID" ]; then
    if [ "$target" = "remote" ]; then
      echo -e "${GREEN}│${NC}  ${DIM}冰茶 AI 客户端${NC}       ${CYAN}连接远端 (bcai.site)${NC}"
    else
      echo -e "${GREEN}│${NC}  ${DIM}冰茶 AI 客户端${NC}       ${CYAN}连接本地 API (127.0.0.1:3001)${NC}"
    fi
  fi

  echo -e "${GREEN}├──────────────────────────────────────────────────────────┤${NC}"
  if [ "$target" != "remote" ]; then
    echo -e "${GREEN}│${NC}  ${DIM}卡密 (access key)${NC}     ${YELLOW}local-dev${NC}"
  fi
  echo -e "${GREEN}│${NC}  ${DIM}数据目录${NC}              ${DIM}$DATA_DIR${NC}"
  echo -e "${GREEN}│${NC}  ${DIM}Ctrl+C${NC}                ${DIM}停止所有服务${NC}"
  echo -e "${GREEN}└──────────────────────────────────────────────────────────┘${NC}"
  echo ""
}

# ── 本地构建客户端 ──
build_client() {
  echo -e "${BOLD}${CYAN}═══ 构建冰茶 AI 客户端 ═══${NC}"

  # 读取版本号
  local version
  version=$(grep -o 'AppVersion = "[^"]*"' "$WAILS_DIR/updater.go" | cut -d'"' -f2)
  echo -e "  ${DIM}版本: v${version}${NC}"

  # 安装前端依赖
  if [ ! -d "$WAILS_DIR/frontend/node_modules" ]; then
    echo -e "${DIM}[build] 安装前端依赖...${NC}"
    (cd "$WAILS_DIR/frontend" && npm install 2>&1 | tail -3)
  fi

  echo -e "  ${DIM}编译中...${NC}"
  (cd "$WAILS_DIR" && "$WAILS_BIN" build -ldflags "-X main.AppVersion=${version}" 2>&1)

  if [ $? -eq 0 ]; then
    # 找到编译产物
    local bin_path
    bin_path=$(find "$WAILS_DIR/build/bin" -maxdepth 1 -type d -name "*.app" 2>/dev/null | head -1)
    if [ -z "$bin_path" ]; then
      bin_path=$(find "$WAILS_DIR/build/bin" -maxdepth 1 -type f -executable 2>/dev/null | head -1)
    fi
    echo -e "  ${GREEN}✓${NC} 构建成功: ${CYAN}${bin_path}${NC}"
    echo -e "  ${DIM}版本: v${version}${NC}"

    # macOS: 直接打开
    if [ "$(uname)" = "Darwin" ] && [ -d "$bin_path" ]; then
      echo -e "  ${DIM}启动应用...${NC}"
      open "$bin_path"
    fi
  else
    echo -e "  ${RED}✗${NC} 构建失败"
    exit 1
  fi
}

# ── Main ──
main() {
  local mode="${1:-all}"

  check_prerequisites "$mode"
  init_data_dir
  install_deps

  case "$mode" in
    server)
      start_server
      print_banner "local"
      wait "$SERVER_PID" 2>/dev/null || true
      ;;
    client)
      setup_client_env
      start_client
      print_banner "local"
      wait "$CLIENT_PID" 2>/dev/null || true
      ;;
    remote)
      # 启动全部服务，但客户端连远端 bcai.site（不设环境变量，使用代码默认值）
      echo -e "${BOLD}${CYAN}═══ 客户端连接远端 bcai.site ═══${NC}"
      echo -e "  ${DIM}API_BASE  → https://bcai.site/remote-token (默认)${NC}"
      echo -e "  ${DIM}更新检查  → https://bcai.site/updates/latest-wails.json (默认)${NC}"
      echo ""
      start_server
      start_client
      print_banner "remote"
      wait -n "$SERVER_PID" "$CLIENT_PID" 2>/dev/null || wait "$SERVER_PID" 2>/dev/null || true
      ;;
    build)
      build_client
      ;;
    all|*)
      setup_client_env
      start_server
      start_client
      print_banner "local"
      wait -n "$SERVER_PID" "$CLIENT_PID" 2>/dev/null || wait "$SERVER_PID" 2>/dev/null || true
      ;;
  esac
}

main "$@"
