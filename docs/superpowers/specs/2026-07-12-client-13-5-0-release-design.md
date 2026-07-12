# Client 13.5.0 Forced-Upgrade Release Design

**Status:** approved for implementation

## Release contract

- Release version: `13.5.0`.
- Desktop source version: `apps/app/updater.go` `AppVersion = "13.5.0"`.
- Server lease floor: `LeaseService` default `minClientVersion = "13.5.0"`.
- Update manifest floor: workflow input `min_version=13.5.0`, producing `version=13.5.0` and `minVersion=13.5.0`.
- Public changelog: `额度显示准确性与客户端稳定性优化`.

Clients older than 13.5.0 cannot skip the update prompt, and the server returns HTTP 426 when an older client requests a lease. The server floor and manifest floor must move together so UI enforcement and API enforcement cannot disagree.

## Implementation and verification

Update the existing version-floor regression test before changing production constants, confirm it fails against 13.4.2, then update both source constants and run the focused Go/server tests plus the full repository regression.

Commit and push the version bump to `main`, then dispatch `.github/workflows/build-wails.yml` on `main` with version `13.5.0`, the public changelog above, and `min_version=13.5.0`. The workflow builds Windows amd64, macOS arm64/amd64, and Linux amd64; publishes `wails-v13.5.0` to `bingcha-2/bcai-releases`; generates `latest-wails.json`; and pushes that manifest commit back to `main`.

Completion requires all workflow jobs to succeed, the public release to contain every expected platform asset, the manifest version and minimum version to both equal 13.5.0, every URL/hash/size field to be populated, and local `main` to be resynchronized with the workflow-generated manifest commit.

## Server rollout handoff

The release does not directly deploy the production server. The handoff must instruct the operator to stop services, pull `main`, back up `prisma/dev.db`, apply the repository's Prisma migration procedure, restart services, and verify API/Web ports, `/api/health`, and service logs. Caddy is not touched unless domain or reverse-proxy health is separately broken.
