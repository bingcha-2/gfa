/**
 * PhonePoolController — endpoints for phone number pool management.
 *
 * Public endpoints (no auth):
 *   POST /api/phone-pool/sync        — client uploads phones
 *   GET  /api/phone-pool/status/:num — client checks own phone status
 *
 * Admin endpoints (require auth):
 *   GET    /api/phone-pool            — list all
 *   POST   /api/phone-pool/import     — bulk import
 *   POST   /api/phone-pool/:id/disable — disable phone
 *   DELETE /api/phone-pool/:id        — delete phone
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from "@nestjs/common";
import { Public } from "../../shared/auth/public.decorator";
import { PhonePoolService } from "./phone-pool.service";

@Controller(["phone-pool", "console/phone-pool"])
export class PhonePoolController {
  constructor(private readonly service: PhonePoolService) {}

  // ── Public endpoints (called by GFA Client) ──

  /** Client uploads its local phone numbers */
  @Post("sync")
  @Public()
  async sync(
    @Body()
    body: {
      phones: Array<{
        phoneNumber: string;
        countryCode?: string;
        smsUrl: string;
      }>;
      source?: string;
    }
  ) {
    return this.service.syncFromClient(body.phones, body.source);
  }

  /** Client checks status of a specific phone number */
  @Get("status/:phoneNumber")
  @Public()
  async getStatus(@Param("phoneNumber") phoneNumber: string) {
    const result = await this.service.getPhoneStatus(
      decodeURIComponent(phoneNumber)
    );
    if (!result) {
      return { phoneNumber, status: "unknown" };
    }
    return result;
  }

  // ── Admin endpoints ──

  /** List all phone numbers */
  @Get()
  async listAll() {
    return this.service.listAll();
  }

  /** Bulk import (format: phoneNumber|smsUrl per line) */
  @Post("import")
  async bulkImport(
    @Body() body: { lines: string[]; source?: string }
  ) {
    return this.service.bulkImport(body.lines, body.source);
  }

  /** Disable a phone */
  @Post(":id/disable")
  async disable(
    @Param("id") id: string,
    @Body() body: { reason?: string }
  ) {
    return this.service.disablePhone(id, body.reason);
  }

  /** Delete a phone */
  @Delete(":id")
  async deletePhone(@Param("id") id: string) {
    return this.service.deletePhone(id);
  }
}
