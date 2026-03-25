import { IsString, IsOptional, IsEnum, IsNotEmpty, IsArray, ArrayNotEmpty } from "class-validator";

export class CreateAccountDto {
  @IsString()
  name!: string;

  @IsString()
  loginEmail!: string;

  @IsString()
  adspowerProfileId!: string;

  @IsOptional()
  @IsString()
  loginPassword?: string;

  @IsOptional()
  @IsString()
  totpSecret?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  adspowerProfileId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  loginPassword?: string;

  @IsOptional()
  @IsString()
  totpSecret?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class BulkImportDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  lines!: string[];
}
