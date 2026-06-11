import { IsString, MaxLength } from "class-validator";

export class AppLogoutDto {
  @IsString()
  @MaxLength(200)
  deviceId!: string;
}
