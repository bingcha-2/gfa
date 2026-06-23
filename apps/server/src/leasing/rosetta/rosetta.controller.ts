import { Body, Controller, Get, Post, Query, Headers, UnauthorizedException } from "@nestjs/common";

import { RosettaService } from "./rosetta.service";
import { TokenUsageStatsService, deriveAccountHealth, type AccountStatusInput } from "./token-usage-stats.service";
import { TokenServerService } from "../token-server/token-server.service";
import { RemoteCodexService } from "../remote-codex/service/remote-codex.service";
import { RemoteAnthropicService } from "../remote-anthropic/service/remote-anthropic.service";
import { Public } from "../../shared/auth/public.decorator";

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
   * 用 DB 订阅占用(座位真相源)覆盖账号列表的 usedShares。底层 list 仍按文件卡
   * 口径(access-keys.json,已退役)算 usedShares,这里统一改成订阅口径,与下单
   * 选号(entitlement-sync)一致 —— 否则订阅占了座位、后台「份额用量」仍显示 0/N。
   */
  private async overlaySubscriptionShares<T extends { accounts: Array<{ id: number; usedShares: number }> }>(
    res: T,
    product: string,
  ): Promise<T> {
    const shares = await this.rosetta.occupiedSharesFromSubscriptions(product);
    for (const acc of res.accounts) {
      acc.usedShares = shares.get(Number(acc.id)) || 0;
    }
    return res;
  }

  @Get("employees")
  listEmployees() {
    return this.rosetta.listEmployees();
  }

  @Get("accounts")
  async listAccounts() {
    return this.overlaySubscriptionShares(this.rosetta.listAccounts(), "antigravity");
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
  startGoogleOAuthLogin(@Body() body: any) {
    return this.rosetta.startGoogleOAuthLogin({ targetAccountId: Number(body?.targetAccountId || 0) });
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
  async submitGoogleOAuthCallback(@Body() body: any) {
    const result = await this.rosetta.submitGoogleOAuthCallback(String(body?.loginId || ""), String(body?.input || ""));
    // 重授权完成:若该号是 auth-dead,刷新成功 → 解封放回候选池。
    if (result?.ok && (result as any).accountId) {
      const { reactivated } = this.tokenServer.reactivateIfAuthDead(Number((result as any).accountId));
      return { ...result, reactivated };
    }
    return result;
  }

  // ── Codex account pool ──────────────────────────────────────────────
  @Get("codex-accounts")
  async listCodexAccounts() {
    return this.overlaySubscriptionShares(this.rosetta.listCodexAccounts(), "codex");
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

  // 自动上号(接码):浏览器自动完成 OpenAI 登录+短信接码,异步任务+轮询。
  // body = { email, password, totpSecret?, phoneNumber, smsUrl, proxyUrl }
  @Post("codex-auto-login")
  startAutomatedCodexLogin(@Body() body: any) {
    return this.rosetta.startAutomatedCodexLogin(body);
  }

  @Get("codex-auto-login-status")
  getAutomatedCodexLoginStatus(@Query("jobId") jobId?: string) {
    return this.rosetta.getAutomatedCodexLoginStatus(String(jobId || ""));
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
  async listClaudeAccounts() {
    return this.overlaySubscriptionShares(this.rosetta.listClaudeAccounts(), "anthropic");
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

  @Post("anthropic-manual-login")
  startManualClaudeLogin(@Body() body: any) {
    return this.rosetta.startManualClaudeLogin(body);
  }

  @Get("anthropic-manual-login-status")
  getManualClaudeLoginStatus(@Query("taskId") taskId?: string) {
    return this.rosetta.getManualClaudeLoginStatus(String(taskId || ""));
  }

  @Get("anthropic-precharge-accounts")
  listClaudePrechargeAccounts() {
    return this.rosetta.listClaudePrechargeAccounts();
  }

  @Post("anthropic-precharge-import")
  importClaudePrechargeAccounts(@Body() body: any) {
    return this.rosetta.importClaudePrechargeAccounts(body);
  }

  @Post("anthropic-precharge-login-probe")
  loginProbeClaudePrecharge(@Body() body: any) {
    return this.rosetta.loginProbeClaudePrecharge(body);
  }

  @Post("anthropic-precharge-quick-probe")
  quickProbeClaudePrecharge(@Body() body: any) {
    return this.rosetta.quickProbeClaudePrecharge(body);
  }

  @Post("anthropic-precharge-mark-topup")
  markTopupClaudePrecharge(@Body() body: any) {
    return this.rosetta.markTopupClaudePrecharge(body);
  }

  @Post("anthropic-precharge-manual-login")
  manualLoginClaudePrecharge(@Body() body: any) {
    return this.rosetta.manualLoginClaudePrecharge(body);
  }

  @Post("anthropic-precharge-activate")
  activateClaudePrecharge(@Body() body: any) {
    return this.rosetta.activateClaudePrecharge(body);
  }

  @Post("anthropic-precharge-activate-sk")
  activateClaudePrechargeWithSessionKey(@Body() body: any) {
    return this.rosetta.activateClaudePrechargeWithSessionKey(body);
  }

  @Post("anthropic-precharge-delete")
  deleteClaudePrechargeAccount(@Body() body: any) {
    return this.rosetta.deleteClaudePrechargeAccount(body);
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

  // ── Claude Session Pool / 白号登录号池 ─────────────────────────────────
  @Get("claude-session-accounts")
  listClaudeSessionAccounts() {
    return this.rosetta.listClaudeSessionAccounts();
  }

  @Post("claude-session-add-account")
  addClaudeSessionAccount(@Body() body: any) {
    return this.rosetta.addClaudeSessionAccount(body);
  }

  @Post("claude-session-batch-import")
  batchImportClaudeSessionAccounts(@Body() body: any) {
    return this.rosetta.batchImportClaudeSessionAccounts(body);
  }

  @Post("claude-session-delete-account")
  deleteClaudeSessionAccount(@Body() body: any) {
    return this.rosetta.deleteClaudeSessionAccount(body);
  }

  @Post("claude-session-toggle-account")
  toggleClaudeSessionAccount(@Body() body: any) {
    return this.rosetta.toggleClaudeSessionAccount(body);
  }

  @Post("claude-session-set-proxy")
  setClaudeSessionProxy(@Body() body: any) {
    return this.rosetta.setClaudeSessionProxy(body);
  }

  @Post("claude-session-update-key")
  updateClaudeSessionKey(@Body() body: any) {
    return this.rosetta.updateClaudeSessionKey(body);
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

  // ── Per-card token usage (aggregated) ───────────────────────────────────

  @Post("adspower-reauthorize")
  adspowerReauthorize(@Body() body: any) {
    return this.rosetta.adspowerReauthorize(body);
  }

  @Get("adspower-reauthorize-status")
  async adspowerReauthorizeStatus(@Query("batchId") batchId: string) {
    const result = await this.rosetta.adspowerReauthorizeStatus(batchId);
    if (result?.ok && Array.isArray((result as any).items)) {
      let reactivated = 0;
      for (const item of (result as any).items) {
        if (item?.status !== "success" || !item?.accountId) continue;
        const r = this.tokenServer.reactivateIfAuthDead(Number(item.accountId));
        if (r.reactivated) reactivated += 1;
      }
      return { ...result, reactivated };
    }
    return result;
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

  /** 封号分析页:母号风险榜(反代率/扇出/失败率/量)+ 封号事件流(codex+claude)。
   *  顺便把母号在池中的运行状态(启用/配额/Token 失效)按 email join 进风险榜。 */
  @Get("ban-analysis")
  async getBanAnalysis(@Query("days") days?: string) {
    const analysis = await this.tokenUsageStats.getBanAnalysis({ days: Number(days) || 3 });
    const statusMap = this.buildAccountStatusMap();
    return {
      ...analysis,
      accounts: analysis.accounts.map((a) => ({
        ...a,
        status: deriveAccountHealth(statusMap.get(`${a.product} ${a.accountEmail}`) ?? { found: false }),
      })),
    };
  }

  /** 从两家 LeaseService 取池内母号运行状态,键 `${product} ${email}`。 */
  private buildAccountStatusMap(): Map<string, AccountStatusInput> {
    const map = new Map<string, AccountStatusInput>();
    const collect = (product: "anthropic" | "codex", svc: { getStatus(): any }) => {
      let accounts: any[] = [];
      try { accounts = svc.getStatus()?.quota?.accounts ?? []; } catch { accounts = []; }
      for (const acc of accounts) {
        if (!acc?.email) continue;
        map.set(`${product} ${acc.email}`, {
          found: true, enabled: acc.enabled !== false,
          quotaStatus: acc.quotaStatus, quotaStatusReason: acc.quotaStatusReason,
        });
      }
    };
    collect("anthropic", this.remoteAnthropic);
    collect("codex", this.remoteCodex);
    return map;
  }

  /** 单条封号事件的"封号前请求时间线"(下钻)。 */
  @Get("ban-event-requests")
  getBanEventRequests(@Query("id") id?: string) {
    return this.tokenUsageStats.getBanEventRequests(String(id || ""));
  }

  /** per-request 热表浏览(近 ≤72h):按 母号/卡/surface/反代 过滤。 */
  @Get("request-logs")
  getRequestLogs(
    @Query("accountEmail") accountEmail?: string,
    @Query("accessKeyId") accessKeyId?: string,
    @Query("surface") surface?: string,
    @Query("reverseProxy") reverseProxy?: string,
    @Query("hours") hours?: string,
    @Query("limit") limit?: string,
  ) {
    return this.tokenUsageStats.getRequestLogs({
      accountEmail, accessKeyId, surface,
      reverseProxyOnly: reverseProxy === "1" || reverseProxy === "true",
      hours: hours ? Number(hours) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get("cliproxy-status")
  getCliProxyStatus() {
    return this.rosetta.getCliProxyStatus();
  }

  @Post("cliproxy-resync-account")
  resyncCliProxyAccount(@Body() body: any) {
    return this.rosetta.resyncCliProxyAccount(body);
  }

  @Post("cliproxy-report")
  @Public()
  reportCliProxyFailure(@Headers("x-cliproxy-report-secret") secret: string, @Body() body: any) {
    if (!process.env.CLIPROXY_REPORT_SECRET || secret !== process.env.CLIPROXY_REPORT_SECRET) {
      throw new UnauthorizedException("Invalid CLIProxy report secret");
    }
    return this.rosetta.handleCliProxyReport(body, this.tokenServer);
  }

  @Post("cliproxy-reconcile")
  reconcileCliProxy(@Body() body: any) {
    return this.rosetta.reconcileCliProxy(body);
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
