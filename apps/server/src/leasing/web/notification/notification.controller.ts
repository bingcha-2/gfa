import { Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";

import { Public } from "../../../shared/auth/public.decorator";
import { CustomerJwtGuard } from "../customer-auth/customer-jwt.guard";
import { CurrentCustomer } from "../customer-auth/customer.decorator";
import { CustomerUser } from "../customer-auth/customer-jwt.strategy";
import { NotificationService } from "./notification.service";

/**
 * NotificationController — customer notification inbox.
 *
 * Routes (all @Public() + CustomerJwtGuard):
 *   GET  /api/web/notifications            list + unread count
 *   POST /api/web/notifications/:id/read   mark one read (ownership; 404 if not found/other's)
 *   POST /api/web/notifications/read-all   mark all unread read
 */
@Controller("web/notifications")
@Public()
@UseGuards(CustomerJwtGuard)
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  /**
   * GET /api/web/notifications?page=&pageSize=
   * → { notifications: [{id,type,title,body,readAt,createdAt}], total, unread }
   */
  @Get()
  list(
    @CurrentCustomer() customer: CustomerUser,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.notificationService.list(customer.customerId, {
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }

  /**
   * POST /api/web/notifications/read-all
   * → { ok: true, updated: n }
   * Must appear BEFORE :id to avoid "read-all" being captured as a param.
   */
  @Post("read-all")
  readAll(@CurrentCustomer() customer: CustomerUser) {
    return this.notificationService.markAllRead(customer.customerId);
  }

  /**
   * POST /api/web/notifications/:id/read
   * → { ok: true }
   * Ownership: unknown/other-customer's notification → 404.
   */
  @Post(":id/read")
  markRead(
    @CurrentCustomer() customer: CustomerUser,
    @Param("id") id: string,
  ) {
    return this.notificationService.markRead(customer.customerId, id);
  }
}
