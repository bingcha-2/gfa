import { IsIn, IsNotEmpty, IsString } from "class-validator";

export class CreateOrderDto {
  @IsNotEmpty()
  @IsString()
  planId!: string;

  @IsIn(["ALIPAY", "WXPAY"])
  channel!: "ALIPAY" | "WXPAY";
}
