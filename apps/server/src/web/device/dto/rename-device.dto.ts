import { IsNotEmpty, IsString, MaxLength } from "class-validator";
import { Transform } from "class-transformer";

export class RenameDeviceDto {
  /** New device name — trimmed; must be nonempty after trim and ≤60 chars. */
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;
}
