import { Body, Controller, Get, Post, Query } from "@nestjs/common";

import { Public } from "../auth/public.decorator";
import { RosettaService } from "./rosetta.service";
import { CreditStatsService } from "./credit-stats.service";
import { TokenServerService } from "../token-server/token-server.service";

@Public()
@Controller("rosetta")
export class RosettaController {
  constructor(
    private readonly rosetta: RosettaService,
    private readonly creditStats: CreditStatsService,
    private readonly tokenServer: TokenServerService,
  ) {}

  @Get("access-keys")
  listAccessKeys(@Query("search") search?: string) {
    return this.rosetta.listAccessKeys({ search });
  }

  @Get("employees")
  listEmployees() {
    return this.rosetta.listEmployees();
  }

  @Get("accounts")
  listAccounts() {
    return this.rosetta.listAccounts();
  }

  @Post("add-account")
  addAccount(@Body() body: any) {
    return this.rosetta.addAccount(body);
  }

  @Post("toggle-account")
  toggleAccount(@Body() body: any) {
    return this.rosetta.toggleAccount(body);
  }

  @Post("delete-account")
  deleteAccount(@Body() body: any) {
    return this.rosetta.deleteAccount(body);
  }

  @Post("access-key")
  createAccessKey(@Body() body: any) {
    const result = this.rosetta.createAccessKey(body);
    this.tokenServer.reloadAccessKeys();
    return result;
  }

  @Post("access-key-update")
  updateAccessKey(@Body() body: any) {
    const result = this.rosetta.updateAccessKey(body);
    this.tokenServer.reloadAccessKeys();
    return result;
  }

  @Post("access-key-delete")
  deleteAccessKey(@Body() body: any) {
    const result = this.rosetta.deleteAccessKey(body);
    this.tokenServer.reloadAccessKeys();
    return result;
  }

  @Post("cleanup-expired-keys")
  cleanupExpiredKeys() {
    const result = this.rosetta.cleanupExpiredKeys();
    this.tokenServer.reloadAccessKeys();
    return result;
  }

  @Post("cleanup-unbound-keys")
  cleanupUnboundKeys() {
    const result = this.rosetta.cleanupUnboundKeys();
    this.tokenServer.reloadAccessKeys();
    return result;
  }

  @Get("throttle-config")
  getThrottleConfig() {
    return this.rosetta.getThrottleConfig();
  }

  @Post("throttle-config")
  saveThrottleConfig(@Body() body: any) {
    return this.rosetta.saveThrottleConfig(body);
  }

  @Post("captcha-unblock")
  createCaptchaUnblock(@Body() body: any) {
    return this.rosetta.createCaptchaUnblock(body);
  }

  @Get("captcha-unblock/status")
  getCaptchaUnblockStatus() {
    return this.rosetta.getCaptchaUnblockStatus();
  }

  @Post("captcha-unblock/retry")
  retryCaptchaUnblock(@Body() body: any) {
    return this.rosetta.retryCaptchaUnblock(body);
  }

  @Post("unblock-location")
  unblockLocation() {
    return this.rosetta.unblockLocation();
  }

  @Post("api/pool/refresh-credits")
  refreshCredits() {
    return this.rosetta.refreshCredits();
  }

  @Post("refresh-quota")
  refreshQuota() {
    return this.rosetta.refreshQuota();
  }

  @Post("adspower-import")
  adspowerImport(@Body() body: any) {
    return this.rosetta.adspowerImport(body);
  }

  @Get("adspower-import-status")
  adspowerImportStatus(@Query("batchId") batchId: string) {
    return this.rosetta.adspowerImportStatus(batchId);
  }

  @Get("adspower-import-history")
  adspowerImportHistory() {
    return this.rosetta.adspowerImportHistory();
  }

  @Get("credit-stats")
  getCreditStats(@Query("days") days?: string) {
    return this.creditStats.getCreditStats(Number(days) || 7);
  }

  @Get("credit-snapshots")
  getCreditSnapshots(@Query("days") days?: string) {
    return this.creditStats.getCreditSnapshots(Number(days) || 7);
  }

  @Get("credit-consumption")
  getCreditConsumption(
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("search") search?: string,
    @Query("days") days?: string,
  ) {
    return this.creditStats.getConsumptionRecords({
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 30,
      search,
      days: Number(days) || 7,
    });
  }
}
