import { IsString, IsOptional, IsNotEmpty, IsArray, ArrayNotEmpty } from "class-validator";

export class CreateAccountDto {
  @IsString()
  name!: string;

  @IsString()
  loginEmail!: string;

  @IsOptional()
  @IsString()
  adspowerProfileId?: string;


  @IsString()
  @IsNotEmpty()
  loginPassword!: string;

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
  @IsNotEmpty()
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
