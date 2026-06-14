import { IsBoolean, IsString, MaxLength, MinLength } from "class-validator";
import { Transform } from "class-transformer";

export class CreateTicketDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  subject!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;
}

export class CreateMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;
}

export class SetTicketUrgentDto {
  @IsBoolean()
  urgent!: boolean;
}
