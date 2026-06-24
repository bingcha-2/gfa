# AdsPower Profile Lifecycle For Onboarding

## Goal

Make onboarding use one sticky AdsPower profile per upstream account, so Claude, Codex, and later Antigravity accounts keep cookies/fingerprint/proxy tied to that account instead of reusing another account's browser state.

## Scope

- Add server-side AdsPower create/list/delete support.
- Add a shared profile manager that:
  - reuses an account's existing `adspowerProfileId` when it is still present;
  - refuses silent reuse when a bound profile is missing, returning a restore-needed error;
  - creates a new profile from the account proxy when no profile is bound;
  - enforces `ADSPOWER_PROFILE_CAP` by deleting the oldest safe idle profile into AdsPower Trash;
  - marks deleted bindings as `trashed` while keeping the original profile id for manual recovery.
- Update Codex onboarding so phone number and SMS URL are optional until the flow reaches the phone-verification page.
- Update Codex onboarding to use AdsPower profile binding and Outlook mailbox email-code verification.
- Surface profile metadata on the Codex account list and form.

## Non-Goals For This Patch

- Public AdsPower Local API does not expose Trash restore, so restore stays manual in AdsPower UI.
- Antigravity runtime worker pool still needs a later worker-level patch to move from `ADSPOWER_POOL_IDS` rotation to account-bound profiles. This patch lays the shared manager used by that follow-up.

## Verification

- Add unit tests for profile lifecycle selection and Codex optional phone/SMS validation.
- Add pure helper tests for OpenAI/Outlook email-code extraction.
- Run targeted server tests, server lint/build, and web lint/build if the Codex page changes.
