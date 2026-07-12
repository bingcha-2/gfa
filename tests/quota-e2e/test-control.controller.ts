// Named test artifact and single import point; implementation lives under the
// server tsconfig root so Nest uses the same decorator transform as production.
export {
  configureQuotaE2ETestControl,
  QuotaE2ETestControlController,
} from "../../apps/server/src/leasing/quota/__tests__/quota-e2e-test-control.controller";
