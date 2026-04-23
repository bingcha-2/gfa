import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail, IsInt, IsOptional, IsString, Min } from "class-validator";

/**
 * DTO for bulk-invite: invite up to 5 emails to a family group in one request.
 * Limit of 5 aligns with Google One family group max member count.
 */
export class BulkInviteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsEmail({}, { each: true })
  emails!: string[];

  /** Member validity in days (default 30). */
  @IsOptional()
  @IsInt()
  @Min(1)
  validDays?: number;

  /** Source tag for tracking origin (e.g. "agent-service"). */
  @IsOptional()
  @IsString()
  source?: string;
}
