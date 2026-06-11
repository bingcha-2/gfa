import { IsEmail } from "class-validator";
import { Transform } from "class-transformer";

export class ForgotPasswordDto {
  @IsEmail()
  @Transform(({ value }) => (typeof value === "string" ? value.toLowerCase().trim() : value))
  email!: string;
}
