import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

export class CreateKnowledgeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  question!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  answer!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  category?: string;

  /** 默认 true:直接发布;false 则入草稿待审。 */
  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}

export class DistillTicketsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  ticketIds!: string[];
}

export class UpdateKnowledgeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  question?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  answer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  category?: string;
}

export class MergeKnowledgeDto {
  @IsString()
  primaryId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  otherIds!: string[];
}
