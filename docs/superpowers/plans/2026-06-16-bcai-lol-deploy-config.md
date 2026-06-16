# bcai.lol Deploy Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the deployment configuration from `bcai.space` to `bcai.lol` without touching database content.

**Architecture:** Update the root deployment env and Caddy routing together so host isolation, cookie scoping, portal links, and payment callbacks all agree on the new domain set. Keep the API base on localhost for server-side fetches, and leave the database file untouched.

**Tech Stack:** PowerShell, Caddy, Next.js env vars, NestJS env vars

---

### Task 1: Update deployment env

**Files:**
- Modify: `D:/GFA-per/.env`

- [ ] **Step 1: Apply the production host and callback values**

```dotenv
WEB_BASE_URL="https://my.bcai.lol"
NEXT_PUBLIC_ACCOUNT_URL="https://my.bcai.lol/account"
NEXT_PUBLIC_MARKETING_ORIGIN="https://bcai.lol"
MARKETING_HOST="bcai.lol"
ACCOUNT_HOST="my.bcai.lol"
CONSOLE_HOST="console.bcai.lol"
ACCOUNT_COOKIE_DOMAIN="my.bcai.lol"
CONSOLE_COOKIE_DOMAIN="console.bcai.lol"
CONSOLE_COOKIE_SECURE="true"
CORS_ALLOWED_ORIGINS="https://bcai.lol,https://my.bcai.lol,https://console.bcai.lol"
EPAY_NOTIFY_URL="https://api.bcai.lol/api/epay/notify"
EPAY_RETURN_URL="https://my.bcai.lol/account/billing"
```

- [ ] **Step 2: Keep the local API base unchanged**

```dotenv
API_BASE_URL="http://localhost:3001/api"
```

### Task 2: Update Caddy routing

**Files:**
- Modify: `D:/GFA-per/Caddyfile`

- [ ] **Step 1: Replace the `bcai.space` hostnames with `bcai.lol`**

```caddyfile
bcai.lol {
	handle /updates/* {
		root * D:/gfa/apps/web/public/updates
		uri strip_prefix /updates
		file_server
	}

	handle /api/faq-images/* {
		reverse_proxy localhost:3000
	}

	@notMarketing path /account /account/* /console /console/* /login /login/* /api/*
	handle @notMarketing {
		respond 404
	}

	handle {
		reverse_proxy localhost:3000
	}
}
```

- [ ] **Step 2: Update the `my`, `console`, and `api` site blocks to `bcai.lol`**

```caddyfile
my.bcai.lol { reverse_proxy localhost:3000 }
console.bcai.lol { reverse_proxy localhost:3000 }
api.bcai.lol { reverse_proxy localhost:3001 }
```

### Task 3: Verify the cutover

**Files:**
- Modify: none
- Test: runtime checks only

- [ ] **Step 1: Validate Caddy config**

```powershell
D:\caddy.exe validate --config D:\GFA-per\Caddyfile
```

- [ ] **Step 2: Restart the app stack**

```powershell
cd D:\GFA-per
pnpm start:stop
pnpm start:daemon
```

- [ ] **Step 3: Confirm health**

```powershell
curl.exe http://127.0.0.1:3001/api/health
netstat -ano | findstr ":3000 :3001"
```
