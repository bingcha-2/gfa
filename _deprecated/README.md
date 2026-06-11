# Deprecated Code

This directory contains deprecated/superseded code that is no longer in use.

## `bcai-client/` (Electron Desktop App)

**Superseded by**: `apps/app/` (Wails Desktop App, formerly `apps/bcai-wails/`)

The Electron-based desktop client was the first version of the 冰茶AI desktop app.
It has been fully replaced by the Wails (Go + WebView) version which:

- Embeds the proxy engine directly in the Go binary (no separate child process needed)
- Uses Wails bindings for frontend ↔ backend communication (no HTTP status port needed)
- Includes additional features: auto-updater, local account pool, IDE injection

### Sub-components also deprecated:

- **`bcai-client/proxy-engine/`** — Standalone Go proxy engine that was designed to be
  spawned by the Electron app. Its code evolved into `apps/app/` where it runs in-process.
- **`bcai-client/src/main/index.ts`** — Electron main process with IPC, tray, and
  `spawnTokenProxy()` logic for launching Node.js child processes.
- **`bcai-client/src/main/https-gateway.ts`** — HTTPS gateway for forwarding to token-proxy.

---

## `gfa-client/` (Tauri Desktop App)

**Superseded by**: `apps/app/` (Wails Desktop App, formerly `apps/bcai-wails/`)

An earlier Tauri-based desktop client (v3.x). Last updated 2026-04-10.
Replaced by the Wails version which unifies the Go proxy engine and desktop UI.
