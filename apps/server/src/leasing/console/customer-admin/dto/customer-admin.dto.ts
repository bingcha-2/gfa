import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

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

export class GrantSubscriptionDto {
  @IsString()
  @IsNotEmpty()
  planId!: string;
}
