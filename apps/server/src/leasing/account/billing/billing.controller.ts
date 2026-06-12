/**
 * billing.controller.ts — customer billing endpoints.
 *
 * All endpoints are @Public() (skip global JwtAuthGuard) + @UseGuards(CustomerJwtGuard).
 */
import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";

import { Public } from "../../../shared/auth/public.decorator";
import { CustomerJwtGuard } from "../customer-auth/customer-jwt.guard";
import { CurrentCustomer } from "../customer-auth/customer.decorator";
import type { CustomerUser } from "../customer-auth/customer-jwt.strategy";
import { BillingService } from "./billing.service";
import { CreateOrderDto } from "./dto/create-order.dto";

@Public()
@UseGuards(CustomerJwtGuard)
@Controller("account")
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  /** POST /api/account/billing/orders → 201 */
  @Post("billing/orders")
  @HttpCode(201)
  createOrder(
    @CurrentCustomer() customer: CustomerUser,
    @Body() dto: CreateOrderDto,
  ) {
    return this.billingService.createOrder(customer.customerId, dto.planId, dto.channel);
  }

  /** GET /api/account/billing/orders?page=&pageSize= */
  @Get("billing/orders")
  listOrders(
    @CurrentCustomer() customer: CustomerUser,
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("pageSize", new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
  ) {
    return this.billingService.listOrders(customer.customerId, page, pageSize);
  }

  /** GET /api/account/billing/orders/:outTradeNo */
  @Get("billing/orders/:outTradeNo")
  getOrder(
    @CurrentCustomer() customer: CustomerUser,
    @Param("outTradeNo") outTradeNo: string,
  ) {
    return this.billingService.getOrder(customer.customerId, outTradeNo);
  }

  /** GET /api/account/subscriptions */
  @Get("subscriptions")
  listSubscriptions(@CurrentCustomer() customer: CustomerUser) {
    return this.billingService.listSubscriptions(customer.customerId);
  }
}
