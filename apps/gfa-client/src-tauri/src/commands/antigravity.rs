// Antigravity commands — local-only operations.
//
// OAuth is now handled by automation.rs (via API/Worker).
// This module only contains the account switching (切号) which stays local.
//
// The old sidecar-based OAuth flow has been removed. The new flow:
//   1. Frontend calls automation.start_antigravity_oauth → API → Worker
//   2. Frontend polls automation.poll_automation_status until SUCCESS
//   3. Frontend reads the token from status.result and saves to local SQLite
