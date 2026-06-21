# Anthropic Precharge Pool Design

## Goal

Add an Anthropic precharge pool for accounts that are not yet Max/Pro. Operators can import accounts, log in with the mailbox password to fetch the Claude organization id and same-environment sessionKey, copy the organization id for top-up, probe the saved web session, and activate the account into the normal Anthropic OAuth pool after top-up.

## Key Decisions

- Keep precharge accounts out of `anthropic-accounts.json` until OAuth succeeds. Store them in `anthropic-precharge-accounts.json`.
- Use mailbox password login as the primary path. Use saved sessionKey only for quick probe and OAuth fallback.
- Treat AdsPower profile id and proxy as part of the account identity. Stored sessionKey should only be reused with the same profile and proxy.
- Probe means web-session probe, not RT probe. It requests `https://claude.ai/api/organizations` with the saved sessionKey in the fixed AdsPower profile and proxy.
- Activation starts OAuth with mailbox password first. If that task fails, the operator can trigger SK fallback from the same row.

## Record Shape

Each precharge record stores:

- `id`, `email`, `mailPassword`, `sessionKey`, `proxyUrl`, `adspowerProfileId`
- `orgId`, `orgName`, `capabilities`, `rateLimitTier`, `billingType`
- `status`: `NEW`, `ORG_READY`, `AWAITING_TOPUP`, `TOPUP_DONE`, `OAUTH_STARTED`, `MOVED_TO_POOL`, `NEEDS_RELOGIN`, `PROBE_FAILED`
- `lastProbeAt`, `lastError`, `createdAt`, `updatedAt`

## Operations

- `list`: returns records with `mailPassword` and `sessionKey` redacted to booleans.
- `import`: accepts lines like `email----password----optional-sessionKey`, plus proxy and AdsPower profile. It stores or updates records.
- `login-probe`: uses mailbox password to trigger magic link login in AdsPower, follows the link, reads organizations, saves org id and sessionKey.
- `quick-probe`: injects saved sessionKey into the fixed AdsPower profile, reads organizations, updates status.
- `mark-topup`: marks an account ready for activation after top-up.
- `activate`: starts the existing Anthropic OAuth auto task with mailbox password. The row shows the task id and status.
- `activate-sk`: starts the existing Anthropic OAuth auto task with saved sessionKey as fallback/manual recovery.
- `delete`: removes a precharge record.

## UI

Add a compact console section inside the Anthropic accounts page above the formal OAuth pool:

- Import panel for precharge lines, shared proxy, and AdsPower profile id.
- Table showing status, org id with copy button, profile/proxy, last probe, and actions.
- Actions are icon buttons with tooltips/titles: login probe, quick probe, mark top-up, activate, SK fallback, delete.

## Error Handling

- Missing proxy/profile blocks login-probe and quick-probe.
- Missing password blocks login-probe and password activation.
- Missing sessionKey blocks quick-probe and SK fallback.
- OAuth failure does not delete the precharge record. It updates `lastError`.
- Successful OAuth moves the operator to the formal pool workflow; automatic deletion can be added later after production confidence.
