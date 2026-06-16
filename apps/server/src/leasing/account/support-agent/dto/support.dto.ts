import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { Transform } from "class-transformer";

export class SupportChatDto {
  /** 续聊用;不传则开新会话。 */
  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  message!: string;
}
