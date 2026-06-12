# Google TOTP & Recovery Email Automation for Claude OAuth Design

This design document outlines the implementation plan for automating Google Sign-In with TOTP 2-Step Verification and Recovery Email inputs within the Rosetta API service.

## User Requirements
- Support importing Google accounts in a multi-segment format, separated by `---` (three dashes) or `----` (four dashes).
- Support both the original `mail.com` format and the new `gmail.com` format.
  - **Gmail format**: `email---password---recoveryEmail---totpSecret` followed by the `sessionKey` (e.g. `sk-ant-sid02-...`) on the next line.
  - **Original Mail format**: `email----password----something----something----sessionKey` on a single line.
- Persist `recoveryEmail` and `totpSecret` in the database (`anthropic-accounts.json`) to allow fully automated re-authentication (silent login) when the session token expires.
- Automate Google Sign-In via AdsPower browser profiles (or plain Chromium proxy contexts) including:
  - Auto-selecting Google Authenticator option on challenge selection pages (`challenge/selection`).
  - Auto-generating TOTP verification codes from `totpSecret` and submitting them on TOTP pages (`challenge/totp`).
  - Auto-filling the `recoveryEmail` if prompted by Google.

## Proposed Changes

### 1. Dependency Updates
#### `@gfa/api` - [package.json](file:///d:/GFA-per/apps/api/package.json)
- Add `"otpauth": "^9.5.0"` to the dependencies to compute time-based one-time passwords from the base32 secret.

### 2. Frontend Updates
#### Rosetta Console - [page.tsx](file:///d:/GFA-per/apps/web/src/app/console/\(dashboard\)/anthropic-accounts/page.tsx)
- Change the import input field from `<Input>` to `<Textarea>` to facilitate multi-line pasting.
- Implement a smart parser in `parseImportLine` to parse both:
  - Original 3/5-segment format.
  - Multi-line Gmail format (Credentials line + sessionKey line).
  - Extract `recoveryEmail` (checking if contains `@`), `totpSecret` (Base32 validation), and `sessionKey` (starts with `sk-ant-`).
- Update `handleAutoOAuth` payload to pass `recoveryEmail` and `totpSecret` to `/api/rosetta/anthropic-auto-oauth`.

### 3. Backend Service & Persistence
#### [claude-account.service.ts](file:///d:/GFA-per/apps/api/src/rosetta/claude-account.service.ts)
- Update `addClaudeAccount` payload to save `recoveryEmail` and `totpSecret` to `anthropic-accounts.json` for each account record.
- In `startAutoClaudeOAuth`, retrieve `recoveryEmail` and `totpSecret` from the database if they are not supplied in the API payload (e.g., during automatic background re-authorization).
- Pass these credentials to `triggerMagicLinkViaBrowser`.

### 4. Browser Automation & 2FA Flow
#### [playwright-oauth.ts](file:///d:/GFA-per/apps/api/src/rosetta/lib/playwright-oauth.ts)
- Accept `recoveryEmail` and `totpSecret` in `PlaywrightOAuthOpts`.
- In the Google login loop:
  - If URL matches `challenge/selection`, locate and click the TOTP challenge option (e.g. `data-challengetype="6"` or matching text like Authenticator).
  - If URL matches `challenge/totp` or an input with type `tel` or name `totpPin` is visible, compute the current TOTP token using `otpauth` and submit it.
  - If a recovery email input is visible (ID/name `knowledgePrereqValue`), fill it with `recoveryEmail` and submit.
  - Guard inputs/submits with single-run flags or URL checks to prevent submit loops.

## Verification Plan

### Automated/Manual Verification
- Run `npx tsx scripts/test_gmail_full_flow.ts` to verify the automated Google Sign-In with TOTP.
- Verify the frontend parses different format combinations correctly.
