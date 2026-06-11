import { IsString, MaxLength } from "class-validator";

export class UpdateProfileDto {
  @IsString()
  @MaxLength(100)
  displayName!: string;
}
