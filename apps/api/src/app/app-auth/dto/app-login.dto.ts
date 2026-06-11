import { IsEmail, IsOptional, IsString, MinLength, MaxLength } from "class-validator";
import { Transform } from "class-transformer";

export class AppLoginDto {
  @IsEmail()
  @Transform(({ value }) => (typeof value === "string" ? value.toLowerCase().trim() : value))
  email!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password!: string;

  @IsString()
  @MaxLength(200)
  deviceId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  deviceName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  clientVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  platform?: string;
}
