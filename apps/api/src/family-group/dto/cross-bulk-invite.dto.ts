import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail } from "class-validator";

/**
 * DTO for cross-group bulk invite.
 * Capped at 1000 emails per request to prevent memory/timeout attacks.
 * System auto-distributes across available groups.
 */
export class CrossBulkInviteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsEmail({}, { each: true })
  emails!: string[];
}
