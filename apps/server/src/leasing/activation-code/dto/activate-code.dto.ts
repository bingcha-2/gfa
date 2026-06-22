import { IsString, MaxLength, MinLength } from "class-validator";
import { Transform } from "class-transformer";

/** 用户兑换激活码:account 端 POST /api/account/activate-code 的请求体。 */
export class ActivateCodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  code!: string;
}
