import { IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

import type { Selection } from "../../plan-catalog/pricing";

/**
 * 后台生成激活码请求体。selection 与购买/授予同结构(PoolSelection | BindSelection),
 * 其合法性由 service 用 computePurchase 对当前目录校验(此处仅做形态校验)。
 */
export class GenerateActivationCodesDto {
  @IsObject()
  selection!: Selection;

  @IsInt()
  @Min(1)
  @Max(200)
  count!: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  batchId?: string;
}
