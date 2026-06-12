import { IsString, MaxLength, MinLength } from "class-validator";
import { Transform } from "class-transformer";

export class BindCardDto {
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  cardKey!: string;
}
