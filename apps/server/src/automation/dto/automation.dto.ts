import { IsString, IsIn, IsOptional, IsArray, IsBoolean, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

export class PhoneInfoDto {
  @IsString()
  phoneNumber!: string;

  @IsOptional()
  @IsString()
  countryCode?: string;

  @IsString()
  smsUrl!: string;
}

export class StartAutomationDto {
  @IsIn(["oauth", "accept-invite", "phone-verify", "family-join"])
  action!: "oauth" | "accept-invite" | "phone-verify" | "family-join";

  /** Account credentials — passed from client's local SQLite */
  @IsString()
  email!: string;

  @IsString()
  password!: string;

  @IsOptional()
  @IsString()
  recoveryEmail?: string;

  @IsOptional()
  @IsString()
  totpSecret?: string;

  @IsOptional()
  @IsString()
  childEmail?: string;

  @IsOptional()
  @IsString()
  childPassword?: string;

  @IsOptional()
  @IsString()
  childRecoveryEmail?: string;

  @IsOptional()
  @IsString()
  childTotpSecret?: string;

  @IsOptional()
  @IsString()
  profileId?: string;

  @IsOptional()
  @IsBoolean()
  keepBrowserOpenOnChallenge?: boolean;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PhoneInfoDto)
  phones?: PhoneInfoDto[];
}

export class BatchOAuthDto {
  /** Array of account credential objects */
  accounts!: BatchOAuthAccount[];
}

export class ConsoleStartDto {
  @IsString()
  accountId!: string;

  @IsIn(["accept-invite", "phone-verify"])
  action!: "accept-invite" | "phone-verify";
}

export class RepairAutomationDto {
  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  profileId?: string;

  @IsOptional()
  @IsBoolean()
  keepBrowserOpenOnChallenge?: boolean;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PhoneInfoDto)
  phones?: PhoneInfoDto[];
}

export class BatchOAuthAccount {
  @IsString()
  email!: string;

  @IsString()
  password!: string;

  @IsOptional()
  @IsString()
  recoveryEmail?: string;

  @IsOptional()
  @IsString()
  totpSecret?: string;
}
