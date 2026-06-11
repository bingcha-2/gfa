import { IsOptional, IsString, MaxLength } from "class-validator";

export class HeartbeatDto {
  @IsString()
  @MaxLength(200)
  deviceId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  clientVersion?: string;
}
