import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";

import type { Selection } from "../../../plan-catalog/pricing";

export class UpdateCustomerDto {
  /** ACTIVE | DISABLED. Setting DISABLED also revokes existing sessions (tokenVersion++). */
  @IsOptional()
  @IsIn(["ACTIVE", "DISABLED"])
  status?: "ACTIVE" | "DISABLED";

  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayName?: string;

  /** Referral credit balance, in cents. */
  @IsOptional()
  @IsInt()
  creditCents?: number;
}

/**
 * 目录版手动授予:提交一个目录 selection(号池/绑定 line + 旋钮),与 CreateCatalogOrderDto 同口径,
 * 由 computePurchase 权威校验(未知 tier/level/product → 400)。typed 为 plain object 以免 whitelist
 * pipe 剥离判别联合的 line 专有字段。
 */
export class GrantCatalogSubscriptionDto {
  @IsObject()
  selection!: Selection;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  durationDays?: number;
}
