import { Body, Controller, Get, Post, Query, Headers, UnauthorizedException, ForbiddenException } from "@nestjs/common";

import { RosettaService } from "./rosetta.service";
import { TokenUsageStatsService } from "./token-usage-stats.service";
import { TokenServerService } from "../token-server/token-server.service";
import { RemoteCodexService } from "../remote-codex/service/remote-codex.service";
import { RemoteAnthropicService } from "../remote-anthropic/service/remote-anthropic.service";

// NOTE: intentionally NOT @Public() — these are admin-console operations
// (account pool, access keys, Codex OAuth token import) that must be gated by the
// global JwtAuthGuard. The web console reaches them same-origin carrying the
// `gfa.console.token` cookie. The desktop client never calls console/rosetta —
// it uses the @Public() app/lease/* controllers, which are unaffected by this
// guard.
@Controller("console/rosetta")
export class RosettaController {
  constructor(
    private readonly rosetta: RosettaService,
    private readonly tokenUsageStats: TokenUsageStatsService,
    private readonly tokenServer: TokenServerService,
    private readonly remoteCodex: RemoteCodexService,
    private readonly remoteAnthropic: RemoteAnthropicService,
  ) {}

  /**
   * 卡密后台管理已停用:账户/订阅体系下不再手动发卡、改卡、绑卡、删卡、批量清理。
   * 路由保留(返回 403 FEATURE_DISABLED)以便可逆 + 前端按钮置灰;开通服务只剩
   * 「账户下单订阅」或「账户 bind-card 转订阅」两条路,均不经后台手动发卡。
   */
  private cardAdminDisabled(): never {
    throw new ForbiddenException({ error: "FEATURE_DISABLED", message: "卡密后台管理已停用,请改用账户订阅。" });
  }

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
    return this.rosetta.addAccountChecked(body);
  }

  @Post("toggle-account")
  toggleAccount(@Body() body: any) {
    return this.rosetta.toggleAccount(body);
  }

  @Post("toggle-account-pool")
  toggleAccountPool(@Body() body: any) {
    return this.rosetta.toggleAccountPool(body);
  }

  // 后台手动恢复:清掉 lease 池【运行时】封禁(需验证/冷却/计数),立即放回候选池。
  // 必须打到持有 LeaseService 的服务上(光改文件 enabled 不会清运行时封禁)。
  @Post("reactivate-account")
  reactivateAccount(@Body() body: any) {
    return this.tokenServer.reactivateAccount(Number(body?.accountId));
  }

  @Post("codex-reactivate-account")
  reactivateCodexAccount(@Body() body: any) {
    return this.remoteCodex.reactivateAccount(Number(body?.accountId));
  }

  @Post("anthropic-reactivate-account")
  reactivateClaudeAccount(@Body() body: any) {
    return this.remoteAnthropic.reactivateAccount(Number(body?.accountId));
  }

  @Post("delete-account")
  deleteAccount(@Body() body: any) {
    return this.rosetta.deleteAccount(body);
  }

  // 「刷新」= 强制刷 token + 拉额度(合并为一个动作)。
  @Post("refresh-account-quota")
  refreshAccountQuota(@Body() body: any) {
    return this.rosetta.refreshAccountQuota(body);
  }

  // ── Google OAuth (Antigravity account pool) ──────────────────────────
  @Post("google-oauth-start")
  startGoogleOAuthLogin() {
    return this.rosetta.startGoogleOAuthLogin();
  }

  @Get("google-oauth-status")
  getGoogleOAuthLoginStatus(@Query("loginId") loginId?: string) {
    return this.rosetta.getGoogleOAuthLoginStatus(String(loginId || ""));
  }

  @Post("google-oauth-cancel")
  cancelGoogleOAuthLogin(@Body() body: any) {
    return this.rosetta.cancelGoogleOAuthLogin(String(body?.loginId || ""));
  }

  @Post("google-oauth-submit")
  submitGoogleOAuthCallback(@Body() body: any) {
    return this.rosetta.submitGoogleOAuthCallback(String(body?.loginId || ""), String(body?.input || ""));
  }

  // ── Codex account pool ──────────────────────────────────────────────
  @Get("codex-accounts")
  listCodexAccounts() {
    return this.rosetta.listCodexAccounts();
  }

  // 导出全部 codex 账号(含 token),返回可被 codex-import-account 原样导入的 JSON。
  @Get("codex-accounts-export")
  exportCodexAccounts() {
    return this.rosetta.exportCodexAccounts();
  }

  @Post("codex-add-account")
  addCodexAccount(@Body() body: any) {
    return this.rosetta.addCodexAccountChecked(body);
  }

  // 单条粘贴 token JSON,或整段导出数据(多账号),统一从这里导入。
  @Post("codex-import-account")
  importCodexAccount(@Body() body: any) {
    return this.rosetta.importCodexAccountsCheckedFromText(body);
  }

  @Post("codex-oauth-start")
  startCodexOAuthLogin() {
    return this.rosetta.startCodexOAuthLogin();
  }

  @Get("codex-oauth-status")
  getCodexOAuthLoginStatus(@Query("loginId") loginId?: string) {
    return this.rosetta.getCodexOAuthLoginStatus(String(loginId || ""));
  }

  @Post("codex-oauth-cancel")
  cancelCodexOAuthLogin(@Body() body: any) {
    return this.rosetta.cancelCodexOAuthLogin(String(body?.loginId || ""));
  }

  @Post("codex-oauth-submit")
  submitCodexOAuthCallback(@Body() body: any) {
    return this.rosetta.submitCodexOAuthCallback(String(body?.loginId || ""), String(body?.input || ""));
  }

  @Post("codex-toggle-account")
  toggleCodexAccount(@Body() body: any) {
    return this.rosetta.toggleCodexAccount(body);
  }

  @Post("codex-toggle-account-pool")
  toggleCodexAccountPool(@Body() body: any) {
    return this.rosetta.toggleCodexAccountPool(body);
  }

  @Post("codex-delete-account")
  deleteCodexAccount(@Body() body: any) {
    return this.rosetta.deleteCodexAccount(body);
  }

  // 「刷新」= 强制刷 token + 拉上游额度(合并为一个动作)。
  @Post("codex-refresh-quota")
  refreshCodexAccountQuota(@Body() body: any) {
    return this.rosetta.refreshCodexAccountQuota(body);
  }

  // ── Claude account pool ─────────────────────────────────────────────
  @Get("anthropic-accounts")
  listClaudeAccounts() {
    return this.rosetta.listClaudeAccounts();
  }

  @Post("anthropic-add-account")
  addClaudeAccount(@Body() body: any) {
    return this.rosetta.addClaudeAccount(body);
  }

  @Post("anthropic-toggle-account")
  toggleClaudeAccount(@Body() body: any) {
    return this.rosetta.toggleClaudeAccount(body);
  }

  @Post("anthropic-toggle-account-pool")
  toggleClaudeAccountPool(@Body() body: any) {
    return this.rosetta.toggleClaudeAccountPool(body);
  }

  @Post("anthropic-delete-account")
  deleteClaudeAccount(@Body() body: any) {
    return this.rosetta.deleteClaudeAccount(body);
  }

  // 设置该号的出口代理(粘性住宅代理 URL);空=清除。anthropic 专用别名,保留兼容。
  @Post("anthropic-set-proxy")
  setClaudeAccountProxy(@Body() body: any) {
    return this.rosetta.setClaudeAccountProxy(body);
  }

  // 设置/清除邮箱密码(token 失效自动重登用)。body = { accountId, mailPassword }。空=清除。
  @Post("anthropic-set-mail-password")
  setClaudeAccountMailPassword(@Body() body: any) {
    return this.rosetta.setClaudeAccountMailPassword(body);
  }

  @Post("anthropic-set-adspower-profile")
  setClaudeAccountAdspowerProfile(@Body() body: any) {
    return this.rosetta.setClaudeAccountAdspowerProfile(body);
  }

  // 通用出口代理设置(御三家共用):body = { provider, accountId, proxyUrl }。空 proxyUrl=清除。
  @Post("account-set-proxy")
  setAccountProxy(@Body() body: any) {
    return this.rosetta.setAccountProxy(body);
  }

  @Post("anthropic-oauth-start")
  startClaudeOAuthLogin(@Body() body: any) {
    return this.rosetta.startClaudeOAuthLogin(body?.proxyUrl ? String(body.proxyUrl) : undefined);
  }

  @Get("anthropic-oauth-status")
  getClaudeOAuthLoginStatus(@Query("loginId") loginId?: string) {
    return this.rosetta.getClaudeOAuthLoginStatus(String(loginId || ""));
  }

  @Post("anthropic-oauth-cancel")
  cancelClaudeOAuthLogin(@Body() body: any) {
    return this.rosetta.cancelClaudeOAuthLogin(String(body?.loginId || ""));
  }

  @Post("anthropic-oauth-submit")
  submitClaudeOAuthCallback(@Body() body: any) {
    return this.rosetta.submitClaudeOAuthCallback(String(body?.loginId || ""), String(body?.input || ""));
  }

  @Post("anthropic-fetch-magic-link")
  fetchClaudeMagicLink(@Body() body: any) {
    return this.rosetta.fetchClaudeMagicLink(body);
  }

  @Post("anthropic-follow-magic-link")
  followClaudeMagicLink(@Body() body: any) {
    return this.rosetta.followClaudeMagicLink(String(body?.loginId || ""), String(body?.url || ""));
  }

  @Post("anthropic-auto-oauth")
  startAutoClaudeOAuth(@Body() body: any) {
    return this.rosetta.startAutoClaudeOAuth(body);
  }

  @Get("anthropic-auto-oauth-status")
  getAutoClaudeOAuthStatus(@Query("taskId") taskId?: string) {
    return this.rosetta.getAutoClaudeOAuthStatus(String(taskId || ""));
  }

  // 「刷新」= 强制刷 token + 探测拉额度(合并为一个动作)。
  @Post("anthropic-refresh-quota")
  async refreshClaudeAccountQuota(@Body() body: any) {
    const result = await this.rosetta.refreshClaudeAccountQuota(body);
    // 刷 token 成功 = 该号鉴权已恢复。若它此前被判「已失效」(quotaStatus=error:
    // 鉴权失效/连续报错/需验证),顺手清掉死号判决并放回候选池 —— 免得还要再点一次「恢复」。
    // 只清 error 态,不动「额度恢复中」(exhausted/cooling):刷 token 不代表额度已回。
    if (result?.ok) {
      const { reactivated } = this.remoteAnthropic.reactivateIfAuthDead(Number(body?.accountId));
      return { ...result, reactivated };
    }
    return result;
  }

  @Post("access-key")
  createAccessKey() {
    return this.cardAdminDisabled();
  }

  @Post("access-key-update")
  updateAccessKey() {
    return this.cardAdminDisabled();
  }

  @Get("access-key-limits")
  getAccessKeyLimits(@Query("id") id: string) {
    return this.rosetta.getAccessKeyLimits(id);
  }

  @Post("access-key-bind")
  bindAccessKey() {
    return this.cardAdminDisabled();
  }

  @Post("access-key-unbind")
  unbindAccessKey() {
    return this.cardAdminDisabled();
  }

  @Post("access-key-set-bindings")
  setAccessKeyBindings() {
    return this.cardAdminDisabled();
  }

  @Post("access-key-delete")
  deleteAccessKey() {
    return this.cardAdminDisabled();
  }

  @Post("cleanup-expired-keys")
  cleanupExpiredKeys() {
    return this.cardAdminDisabled();
  }

  @Post("cleanup-unbound-keys")
  cleanupUnboundKeys() {
    return this.cardAdminDisabled();
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

  @Get("cliproxy-status")
  getCliProxyStatus() {
    return this.rosetta.getCliProxyStatus();
  }

  @Post("upload-cliproxy")
  uploadToCliProxy(@Body() body: any) {
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    return this.rosetta.uploadToCliProxy(ids, body?.clientId, body?.clientSecret, body?.provider);
  }

  @Post("sync")
  syncAccounts(@Headers("x-sync-token") syncToken: string, @Body() body: any) {
    const expectedToken = process.env.ROSETTA_SYNC_TOKEN;
    if (!expectedToken || syncToken !== expectedToken) {
      throw new UnauthorizedException("Invalid sync token");
    }
    return this.rosetta.syncFromPayload(body);
  }
}
