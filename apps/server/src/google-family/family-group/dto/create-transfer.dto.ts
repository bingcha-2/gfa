import { IsArray, IsEmail, IsOptional, IsString } from "class-validator";

/**
 * DTO for creating a cross-group transfer.
 * If memberEmails is omitted, all ACTIVE non-owner members are transferred.
 */
export class CreateTransferDto {
  @IsString()
  sourceGroupId!: string;

  @IsString()
  targetGroupId!: string;

  @IsOptional()
  @IsArray()
  @IsEmail({}, { each: true })
  memberEmails?: string[];
}
