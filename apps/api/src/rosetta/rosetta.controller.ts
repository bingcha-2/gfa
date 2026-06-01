import { Body, Controller, Get, Post, Query } from "@nestjs/common";

import { RosettaService } from "./rosetta.service";
import { CreditStatsService } from "./credit-stats.service";
import { TokenUsageStatsService } from "./token-usage-stats.service";
import { TokenServerService } from "../token-server/token-server.service";

// NOTE: intentionally NOT @Public() — these are admin-console operations
// (account pool, access keys, Codex OAuth token import) that must be gated by the
// global JwtAuthGuard. The web console reaches them same-origin carrying the
// `gfa.console.token` cookie. The desktop client never calls /rosetta/* — it uses
// the @Public() remote-token / remote-codex controllers authenticated by the
// x-token-server-secret access key, which are unaffected by this guard.
@Controller("rosetta")
export class RosettaController {
  constructor(
    private readonly rosetta: RosettaService,
    private readonly creditStats: CreditStatsService,
    private readonly tokenUsageStats: TokenUsageStatsService,
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

  // ── Codex account pool ──────────────────────────────────────────────
  @Get("codex-accounts")
  listCodexAccounts() {
    return this.rosetta.listCodexAccounts();
  }

  @Post("codex-add-account")
  addCodexAccount(@Body() body: any) {
    return this.rosetta.addCodexAccount(body);
  }

  @Post("codex-import-account")
  importCodexAccount(@Body() body: any) {
    return this.rosetta.importCodexAccountFromText(body);
  }

  @Post("codex-toggle-account")
  toggleCodexAccount(@Body() body: any) {
    return this.rosetta.toggleCodexAccount(body);
  }

  @Post("codex-delete-account")
  deleteCodexAccount(@Body() body: any) {
    return this.rosetta.deleteCodexAccount(body);
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
  async deleteAccessKey(@Body() body: any) {
    const result = this.rosetta.deleteAccessKey(body);
    this.tokenServer.reloadAccessKeys();
    // Drop the card's persisted token usage log alongside the card itself.
    const id = String(body?.id || "");
    if (id) await this.tokenUsageStats.deleteCardUsage(id);
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

  // ── Per-card token usage log ────────────────────────────────────────────

  @Get("card-token-usage")
  getCardTokenUsage(
    @Query("cardId") cardId: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("days") days?: string,
  ) {
    return this.tokenUsageStats.getCardUsageRecords({
      accessKeyId: cardId,
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 30,
      days: Number(days) || 30,
    });
  }

  @Get("card-token-usage-summary")
  getCardTokenUsageSummary(@Query("cardId") cardId: string, @Query("days") days?: string) {
    return this.tokenUsageStats.getCardUsageSummary({
      accessKeyId: cardId,
      days: Number(days) || 30,
    });
  }

  /** Persisted "today" token consumption (Beijing day) — restart-safe, replaces
   * the in-memory daily counter on the usage dashboard. */
  @Get("token-usage-today")
  getTokenUsageToday() {
    return this.tokenUsageStats.getTodayUsage();
  }

  /** Global daily token usage trend (all cards, last N Beijing days) for the
   * 用量剩余 dashboard chart. */
  @Get("token-usage-trend")
  getTokenUsageTrend(@Query("days") days?: string) {
    return this.tokenUsageStats.getUsageTrend({ days: Number(days) || 7 });
  }
}
