import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards
} from "@nestjs/common";

import { Public } from "../../../shared/auth/public.decorator";
import { CustomerJwtGuard } from "../customer-auth/customer-jwt.guard";
import { CurrentCustomer } from "../customer-auth/customer.decorator";
import { CustomerUser } from "../customer-auth/customer-jwt.strategy";
import { DeviceService } from "./device.service";
import { RenameDeviceDto } from "./dto/rename-device.dto";

/**
 * DeviceController — customer device management (web portal).
 *
 * All routes are @Public() to skip the global admin JwtAuthGuard, but
 * protected explicitly via CustomerJwtGuard (same pattern as
 * CustomerProfileController).
 *
 * :id is the Device.id primary key (NOT the client-generated deviceId).
 * Ownership is enforced in DeviceService — a device belonging to another
 * customer yields the same 404 DEVICE_NOT_FOUND as a nonexistent one.
 */
@Controller("account/devices")
@Public()
@UseGuards(CustomerJwtGuard)
export class DeviceController {
  constructor(private readonly deviceService: DeviceService) {}

  /**
   * GET /api/account/devices
   * → { devices: [{id, deviceId, name, platform, status, lastSeenAt, lastIp}], deviceLimit }
   */
  @Get()
  list(@CurrentCustomer() customer: CustomerUser) {
    return this.deviceService.list(customer.customerId);
  }

  /**
   * PATCH /api/account/devices/:id
   * Body: { name: string ≤60, nonempty after trim }
   * → { ok: true, device: {...} }
   */
  @Patch(":id")
  async rename(
    @CurrentCustomer() customer: CustomerUser,
    @Param("id") id: string,
    @Body() dto: RenameDeviceDto
  ) {
    const { device } = await this.deviceService.rename(
      customer.customerId,
      id,
      dto.name
    );
    return { ok: true, device };
  }

  /**
   * POST /api/account/devices/:id/revoke
   * → { ok: true }
   * Idempotent — revoking an already-REVOKED device also returns { ok: true }.
   */
  @Post(":id/revoke")
  revoke(
    @CurrentCustomer() customer: CustomerUser,
    @Param("id") id: string
  ) {
    return this.deviceService.revoke(customer.customerId, id);
  }
}
