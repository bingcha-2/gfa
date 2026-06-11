import {
  IsEmail,
  IsOptional,
  IsString,
  MinLength,
  MaxLength
} from "class-validator";
import { Transform } from "class-transformer";

export class RegisterDto {
  @IsEmail()
  @Transform(({ value }) => (typeof value === "string" ? value.toLowerCase().trim() : value))
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  referralCode?: string;
}
