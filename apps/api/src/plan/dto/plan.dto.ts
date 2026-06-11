import {
  IsString,
  IsOptional,
  IsInt,
  IsBoolean,
  IsArray,
  ArrayNotEmpty,
  Min,
  Max,
  MaxLength,
  IsObject,
  IsNotEmpty,
} from "class-validator";

export class CreatePlanDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsInt()
  @Min(0)
  priceCents!: number;

  @IsInt()
  @Min(1)
  durationDays!: number;

  /** Array of valid products. Validated in service against VALID_PRODUCTS. */
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  products!: string[];

  /** Optional per-model caps: { [model: string]: number } */
  @IsOptional()
  @IsObject()
  bucketLimits?: Record<string, number>;

  /** Optional per-product plan levels: { [product: string]: string } */
  @IsOptional()
  @IsObject()
  levels?: Record<string, string>;

  @IsInt()
  @Min(1)
  @Max(8)
  weight!: number;

  @IsInt()
  @Min(1)
  deviceLimit!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  weeklyTokenLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(60000)
  windowMs?: number;

  @IsBoolean()
  active!: boolean;

  @IsInt()
  sortOrder!: number;
}

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  priceCents?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  durationDays?: number;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  products?: string[];

  @IsOptional()
  @IsObject()
  bucketLimits?: Record<string, number>;

  @IsOptional()
  @IsObject()
  levels?: Record<string, string>;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  weight?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  deviceLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  weeklyTokenLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(60000)
  windowMs?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
