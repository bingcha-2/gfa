import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail } from "class-validator";

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
}
