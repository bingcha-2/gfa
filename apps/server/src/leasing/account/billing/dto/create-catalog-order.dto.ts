import { IsIn, IsObject } from "class-validator";

import type { Selection } from "../../../plan-catalog/pricing";

/**
 * Catalog-driven order (spec §8): the client submits a selection (号池/绑定 line +
 * knobs) and the pay channel. The selection is passed through to computePurchase,
 * which is the authoritative validator (unknown tier/level/product → 400). It is
 * typed as a plain object here so the global whitelist pipe doesn't strip the
 * line-specific fields of the discriminated union.
 */
export class CreateCatalogOrderDto {
  @IsObject()
  selection!: Selection;

  @IsIn(["ALIPAY", "WXPAY"])
  channel!: "ALIPAY" | "WXPAY";
}
