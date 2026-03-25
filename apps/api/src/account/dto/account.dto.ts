import { IsString, IsOptional, IsEnum } from "class-validator";

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
