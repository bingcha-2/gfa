import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail } from "class-validator";

/**
 * DTO for bulk-remove: remove up to 5 members from a family group in one request.
 * Limit of 5 aligns with Google One family group max member count.
 */
export class BulkRemoveDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsEmail({}, { each: true })
  memberEmails!: string[];
}
