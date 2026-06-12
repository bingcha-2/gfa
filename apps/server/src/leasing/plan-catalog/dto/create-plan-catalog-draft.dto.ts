import { IsObject } from "class-validator";

/**
 * Console draft creation: the operator submits the full catalog config as a JSON
 * object (products/levels/usageTiers/pricing/durationDays/windowMs — see spec §4.1).
 * Stored as a JSON string by PlanCatalogService (SQLite has no Json type).
 */
export class CreatePlanCatalogDraftDto {
  @IsObject()
  config!: Record<string, unknown>;
}
