# Weekly Fair-Share and Exclusive Quota Cap Design

## Goal

Repair Codex weekly fair-share attribution when the persisted local window starts later than the still-active upstream window, while keeping the `尊贵·独享` badge and single quota bar capped by the upstream account remainder.

## Behavior

- A genuinely expired upstream snapshot remains ignored.
- An earlier-starting upstream window that still overlaps the local active window realigns `windowStart` and continues through the existing delta attribution. Accumulated `weightedUsed` participates in that attribution and is then cleared by the existing merge.
- The 5-hour path remains unchanged when reset boundaries already match.
- Exclusive cards remain single-bar cards. Their visible remainder and health color become `min(card remainder, account remainder)` when account quota is known; account details remain hidden.

## Verification

- Reproduce the production weekly timestamps and prove the snapshot currently remains at `1.0` before the fix.
- Prove the corrected path reaches `0.62`, attributes usage, and still rejects a truly expired snapshot.
- Prove exclusive cards remain single-layer while an 80% card on a 54% account displays 54%.
- Run targeted server/frontend tests, type checks, and the client build before release.
