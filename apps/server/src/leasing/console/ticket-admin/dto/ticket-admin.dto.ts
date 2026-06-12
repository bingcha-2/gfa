import { IsIn, IsNotEmpty, IsString, MaxLength } from "class-validator";

export class ReplyTicketDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body!: string;
}

export class UpdateTicketStatusDto {
  @IsIn(["OPEN", "ANSWERED", "CLOSED"])
  status!: "OPEN" | "ANSWERED" | "CLOSED";
}
