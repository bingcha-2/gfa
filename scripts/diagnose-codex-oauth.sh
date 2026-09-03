#!/usr/bin/env bash
set -u

# Read-only diagnostic for the Codex takeover login-page issue.
# It never prints token contents and never changes auth/config/keychain state.

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CONFIG="$CODEX_HOME/config.toml"
AUTH="$CODEX_HOME/auth.json"
SERVICE="Codex Auth"
PYTHON_BIN="$(command -v python3 || command -v python || true)"

if [[ -z "$PYTHON_BIN" ]]; then
  echo "需要 python3（macOS 通常可通过 Homebrew 安装）才能解析 token 过期时间。"
  exit 1
fi

echo "Codex home: $CODEX_HOME"
echo "Config:    $CONFIG"
echo "Auth file: $AUTH"
echo

if [[ -f "$CONFIG" ]]; then
  model_provider="$(sed -nE 's/^model_provider[[:space:]]*=[[:space:]]*["'"']([^"'"']+)["'"'].*/\1/p' "$CONFIG" | head -n 1)"
  auth_store="$(sed -nE 's/^cli_auth_credentials_store[[:space:]]*=[[:space:]]*["'"']([^"'"']+)["'"'].*/\1/p' "$CONFIG" | head -n 1)"
  # Read requires_openai_auth only from the selected provider table. A later
  # provider must not change the diagnosis for model_provider=bingchaai.
  if [[ -n "$model_provider" ]]; then
    requires_auth="$(awk -v section="[model_providers.$model_provider]" '
      BEGIN { in_section = 0 }
      /^\[.*\]$/ { in_section = ($0 == section); next }
      in_section && /^[[:space:]]*requires_openai_auth[[:space:]]*=/ {
        if ($0 ~ /=[[:space:]]*true([[:space:]]*#.*)?$/) print "true"
        else if ($0 ~ /=[[:space:]]*false([[:space:]]*#.*)?$/) print "false"
        exit
      }
    ' "$CONFIG")"
  else
    requires_auth=""
  fi
  echo "Config model_provider: ${model_provider:-<missing>}"
  echo "Config auth store:    ${auth_store:-<missing>}"
  echo "Provider requires OAuth: ${requires_auth:-<missing>}"
else
  echo "Config: MISSING"
  model_provider=""
  auth_store=""
  requires_auth=""
fi

inspect_json() {
  "$PYTHON_BIN" - "$1" <<'PY'
import base64, json, sys, time

path = sys.argv[1]
try:
    raw = open(path, 'rb').read()
    obj = json.loads(raw)
except Exception as exc:
    print(f"{path}: unreadable ({exc.__class__.__name__})")
    raise SystemExit(0)

tokens = obj.get('tokens') or {}
mode = str(obj.get('auth_mode') or '<missing>')
access = str(tokens.get('access_token') or '')
print(f"{path}: auth_mode={mode} access_token={'present' if access else 'missing'}")
if not access:
    raise SystemExit(0)

parts = access.split('.')
if len(parts) < 2:
    print("  access_token_expiry=opaque (cannot verify locally)")
    raise SystemExit(0)
try:
    padded = parts[1] + '=' * (-len(parts[1]) % 4)
    claims = json.loads(base64.urlsafe_b64decode(padded))
    exp = float(claims.get('exp'))
except Exception:
    print("  access_token_expiry=non-JWT (cannot verify locally)")
    raise SystemExit(0)

remaining = exp - time.time()
if remaining <= 0:
    status = 'EXPIRED'
elif remaining <= 300:
    status = 'NEAR_EXPIRY(<5m)'
else:
    status = 'valid'
print(f"  access_token_expiry={status} remaining_seconds={int(remaining)}")
PY
}

if [[ -f "$AUTH" ]]; then
  inspect_json "$AUTH"
else
  echo "$AUTH: MISSING"
fi

canonical_home="$("$PYTHON_BIN" -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$CODEX_HOME" 2>/dev/null || printf '%s' "$CODEX_HOME")"
digest="$(printf '%s' "$canonical_home" | shasum -a 256 | awk '{print $1}')"
keychain_account="cli|${digest:0:16}"
keychain_secret="$(security find-generic-password -s "$SERVICE" -a "$keychain_account" -w 2>/dev/null || true)"
if [[ -n "$keychain_secret" ]]; then
  echo "Keychain ($SERVICE / $keychain_account): present"
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  printf '%s' "$keychain_secret" > "$tmp"
  "$PYTHON_BIN" - "$tmp" <<'PY'
import base64, json, sys, time

raw = open(sys.argv[1], 'rb').read().strip()
try:
    obj = json.loads(raw)
except Exception:
    try:
        obj = json.loads(bytes.fromhex(raw.decode()))
    except Exception:
        print('  keychain_payload=opaque/non-JSON')
        raise SystemExit(0)

tokens = obj.get('tokens') or {}
access = str(tokens.get('access_token') or '')
print(f"  keychain_access_token={'present' if access else 'missing'}")
parts = access.split('.')
try:
    padded = parts[1] + '=' * (-len(parts[1]) % 4)
    claims = json.loads(base64.urlsafe_b64decode(padded))
    exp = float(claims.get('exp'))
except Exception:
    print('  keychain_access_token_expiry=opaque/non-JWT')
    raise SystemExit(0)
remaining = exp - time.time()
status = 'EXPIRED' if remaining <= 0 else ('NEAR_EXPIRY(<5m)' if remaining <= 300 else 'valid')
print(f"  keychain_access_token_expiry={status} remaining_seconds={int(remaining)}")
PY
else
  echo "Keychain ($SERVICE / $keychain_account): missing"
fi

echo
if [[ "$requires_auth" == "true" ]]; then
  echo "RESULT: OAuth bridge is enabled. If Keychain is EXPIRED/NEAR_EXPIRY, this matches the login-page hypothesis."
  echo "        Refresh official Codex login once, or sign out before takeover to force API-Key/file mode."
elif [[ "$model_provider" == "bingchaai" && "$requires_auth" == "false" && "$auth_store" == "file" ]]; then
  echo "RESULT: API-Key/file takeover shape is present; the login-page cause is not stale OAuth."
else
  echo "RESULT: Configuration is incomplete or ambiguous; do not delete credentials based on this report."
fi
