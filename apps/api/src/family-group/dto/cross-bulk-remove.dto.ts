import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail } from "class-validator";

/**
 * DTO for cross-group bulk remove.
 * No strict upper limit — capped at 1000 to prevent memory/timeout attacks.
 */
export class CrossBulkRemoveDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsEmail({}, { each: true })
  memberEmails!: string[];
}
