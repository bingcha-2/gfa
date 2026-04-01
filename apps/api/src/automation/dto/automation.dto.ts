import { IsString, IsIn, IsOptional } from "class-validator";

export class StartAutomationDto {
  @IsIn(["oauth", "accept-invite"])
  action!: "oauth" | "accept-invite";

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
}

export class BatchOAuthDto {
  /** Array of account credential objects */
  accounts!: BatchOAuthAccount[];
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
