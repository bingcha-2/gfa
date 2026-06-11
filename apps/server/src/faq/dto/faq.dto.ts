import { IsString, IsOptional, IsBoolean, IsInt, MinLength } from 'class-validator';

export class CreateFaqDto {
  @IsString()
  @MinLength(1)
  category!: string;

  @IsString()
  @MinLength(1)
  question!: string;

  @IsString()
  @MinLength(1)
  answer!: string;

  @IsInt()
  @IsOptional()
  sortOrder?: number;

  @IsBoolean()
  @IsOptional()
  published?: boolean;
}

export class UpdateFaqDto {
  @IsString()
  @IsOptional()
  category?: string;

  @IsString()
  @IsOptional()
  question?: string;

  @IsString()
  @IsOptional()
  answer?: string;

  @IsInt()
  @IsOptional()
  sortOrder?: number;

  @IsBoolean()
  @IsOptional()
  published?: boolean;
}
