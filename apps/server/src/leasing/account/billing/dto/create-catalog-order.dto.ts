import { IsIn, IsInt, IsObject, IsOptional, Min } from "class-validator";

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

  // 统一收银台后前端不再预选渠道;保留可选以兼容旧客户端,缺省由服务端占位 ALIPAY。
  @IsOptional()
  @IsIn(["ALIPAY", "WXPAY"])
  channel?: "ALIPAY" | "WXPAY";

  // 余额抵扣额(分,选填)。服务端会夹断到 [0, min(余额, 基础价)] 并原子扣减,前端传值仅作意向。
  @IsOptional()
  @IsInt()
  @Min(0)
  useCreditCents?: number;
}
