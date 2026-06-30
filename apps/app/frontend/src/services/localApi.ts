/**
 * 本地接管(自有号)Wails 封装。
 *
 * 这些 App 方法尚未进 wailsjs 生成绑定(需 `wails generate module`),为不依赖
 * 重新生成、又遵守「不让 window.go.* 散落到组件」的约定,集中在此一处封装。
 *
 * 多 provider(codex / antigravity)共用同一套 UI:每个 provider 暴露一个
 * 满足 ProviderLocalApi 的对象,UI 组件只依赖该接口。
 */

export interface LocalAccountView {
  id: string
  email: string
  name: string
  provider: string
  authKind: string
  note: string
  planType: string
  quotaStatus: string
  tags: string[] | null
  poolEnabled: boolean
  priority: boolean
  hourlyPercent: number
  weeklyPercent: number
  hourlyResetAt: number
  weeklyResetAt: number
  lastUsedAt: number
}

export interface LocalGatewayStatus {
  running: boolean
  addr: string
  port: number
}

export interface LocalStatModel { model: string; requests: number; totalTokens: number }
export interface LocalStatAccount { authId: string; email: string; requests: number; totalTokens: number }
export interface LocalStatRecent { atMs: number; authId: string; model: string; failed: boolean; latencyMs: number }
export interface LocalStatsSnapshot {
  totalRequests: number
  totalFailed: number
  totalInputTokens: number
  totalOutputTokens: number
  byAccount: LocalStatAccount[] | null
  byModel: LocalStatModel[] | null
  recent: LocalStatRecent[] | null
}

export interface WakeupConfig { enabled: boolean; intervalMinutes: number }
export interface WakeupRunEntry { atMs: number; accountId: string; email: string; ok: boolean; err?: string; newExpiry?: number }

/** 自动刷新间隔(分钟):配额自动刷新 / 当前账号刷新。 */
export interface RefreshConfig { quotaMinutes: number; currentMinutes: number }

// ── 反代(codex 网关)运营 ──

/** 路由(选号)策略:priority=优先号优先 / round-robin=轮询 / fair=剩余额度高者优先。 */
export type RoutingStrategy = 'priority' | 'round-robin' | 'fair'

/** 网关访问范围:local=仅本机(127.0.0.1) / lan=局域网(0.0.0.0)。默认仅本机。 */
export type GatewayAccessScope = 'local' | 'lan'

/** 客户端访问 key(调本地 /v1 用)。 */
export interface GatewayKey { id: string; name: string; value: string; createdAt: number }

/** 一条请求日志(email 由后端按 authId 补全)。 */
export interface GatewayLogEntry {
  atMs: number
  authId: string
  email: string
  model: string
  failed: boolean
  latencyMs: number
}

/** 一页请求日志(total=命中过滤的总条数,供分页)。 */
export interface GatewayLogPage { total: number; entries: GatewayLogEntry[] | null }

/** 请求日志过滤条件(空字段=不按该维度过滤)。 */
export interface GatewayLogFilter { model?: string; authId?: string; failedOnly?: boolean }

/** 连通测试结果。 */
export interface GatewayConnTestResult { ok: boolean; status: number; latencyMs: number; err: string }

export interface InstanceProfile {
  id: string
  provider: string
  name: string
  userDataDir: string
  workingDir?: string
  extraArgs?: string
  bindAccountId?: string
  createdAt: number
  lastLaunchedAt?: number
  pid?: number
}

/** 一个 provider 的本地账号能力(UI 组件只依赖此接口)。 */
export interface ProviderLocalApi {
  listAccounts(): Promise<LocalAccountView[]>
  startLogin(): Promise<string>
  waitLogin(loginId: string): Promise<LocalAccountView>
  /** 手动加号:自备 OAuth token。 */
  addByToken(refreshToken: string, accessToken: string, email: string): Promise<LocalAccountView>
  /** 手动加号:自备 API Key。 */
  addByApiKey(apiKey: string, baseURL: string, email: string): Promise<LocalAccountView>
  setPoolEnabled(id: string, enabled: boolean): Promise<void>
  setPriority(id: string): Promise<void>
  /** 按号额度刷新:真去上游拉额度并回填(provider 无关,按 id)。 */
  refreshQuota(id: string): Promise<void>
  /** 刷新本 provider 全部 pool_enabled 自有号额度,返回成功数量。 */
  refreshAllQuotas(): Promise<number>
  /** 账号级编辑(共享绑定,按 id)。 */
  rename(id: string, name: string): Promise<void>
  setNote(id: string, note: string): Promise<void>
  setTags(id: string, tags: string[]): Promise<void>
  deleteAccount(id: string): Promise<void>
  deleteAccounts(ids: string[]): Promise<void>
  gatewayStart(): Promise<LocalGatewayStatus>
  gatewayStop(): Promise<void>
  gatewayStatus(): Promise<LocalGatewayStatus>
  /** 改共享反代端口并重启网关。 */
  setGatewayPort(port: number): Promise<LocalGatewayStatus>
  stats(): Promise<LocalStatsSnapshot>
  exportAccounts(ids: string[]): Promise<string>
  importFromJSON(json: string): Promise<number>
  /** 从本机已装客户端导入(读 ~/.codex/auth.json);仅 codex 支持。返回新增数。 */
  importFromLocal?(): Promise<number>
  /** 导入用户拖入的凭证文件文本(多段);codex/antigravity 支持。返回新增数。 */
  importAuthFiles?(contents: string[]): Promise<number>
  /** 从已装 IDE 同步当前登录号(读 state.vscdb);仅 antigravity 支持。返回新增数。 */
  syncFromIDE?(): Promise<number>
  wakeupConfig(): Promise<WakeupConfig>
  setWakeupConfig(enabled: boolean, intervalMinutes: number): Promise<void>
  wakeupRunNow(): Promise<WakeupRunEntry[]>
  wakeupHistory(): Promise<WakeupRunEntry[]>
  instanceList(): Promise<InstanceProfile[]>
  instanceCreate(name: string, userDataDir: string, workingDir: string, extraArgs: string, bindAccountId: string): Promise<InstanceProfile>
  instanceDelete(id: string): Promise<void>
  instanceUpdate(profile: InstanceProfile): Promise<void>
  instanceLaunch(id: string): Promise<void>
  instanceStop(id: string): Promise<void>
  /** 接管号源切换(仅部分 provider 支持,如 codex)。 */
  getSource?(): Promise<string>
  setSource?(source: 'remote' | 'local'): Promise<void>
}

type GoApp = Record<string, (...args: unknown[]) => Promise<unknown>>

function app(): GoApp {
  const w = window as unknown as { go?: { main?: { App?: GoApp } } }
  const a = w?.go?.main?.App
  if (!a) throw new Error('Wails App bindings unavailable')
  return a
}

export const codexLocalApi: ProviderLocalApi = {
  listAccounts: () => app().LocalListCodexAccounts() as Promise<LocalAccountView[]>,
  startLogin: () => app().LocalStartCodexLogin() as Promise<string>,
  waitLogin: (id) => app().LocalWaitCodexLogin(id) as Promise<LocalAccountView>,
  addByToken: (rt, at, email) => app().LocalAddCodexToken(rt, at, email) as Promise<LocalAccountView>,
  addByApiKey: (key, base, email) => app().LocalAddCodexApiKey(key, base, email) as Promise<LocalAccountView>,
  setPoolEnabled: (id, e) => app().LocalSetPoolEnabled(id, e) as Promise<void>,
  setPriority: (id) => app().LocalSetCodexPriority(id) as Promise<void>,
  refreshQuota: (id) => app().LocalRefreshAccountQuota(id) as Promise<void>,
  refreshAllQuotas: () => app().LocalRefreshAllQuotas('codex') as Promise<number>,
  rename: (id, name) => app().LocalRenameAccount(id, name) as Promise<void>,
  setNote: (id, note) => app().LocalSetAccountNote(id, note) as Promise<void>,
  setTags: (id, tags) => app().LocalSetAccountTags(id, tags) as Promise<void>,
  deleteAccount: (id) => app().LocalDeleteAccount(id) as Promise<void>,
  deleteAccounts: (ids) => app().LocalDeleteAccounts(ids) as Promise<void>,
  gatewayStart: () => app().LocalGatewayStart() as Promise<LocalGatewayStatus>,
  gatewayStop: () => app().LocalGatewayStop() as Promise<void>,
  gatewayStatus: () => app().LocalGatewayStatus() as Promise<LocalGatewayStatus>,
  setGatewayPort: (port) => app().LocalSetGatewayPort(port) as Promise<LocalGatewayStatus>,
  stats: () => app().LocalCodexStats() as Promise<LocalStatsSnapshot>,
  exportAccounts: (ids) => app().LocalExportCodexAccounts(ids) as Promise<string>,
  importFromJSON: (json) => app().LocalImportCodexFromJSON(json) as Promise<number>,
  importFromLocal: () => app().LocalImportCodexFromLocal() as Promise<number>,
  importAuthFiles: (contents) => app().LocalImportCodexAuthFiles(contents) as Promise<number>,
  wakeupConfig: () => app().LocalCodexWakeupConfig() as Promise<WakeupConfig>,
  setWakeupConfig: (e, i) => app().LocalSetCodexWakeupConfig(e, i) as Promise<void>,
  wakeupRunNow: () => app().LocalCodexWakeupRunNow() as Promise<WakeupRunEntry[]>,
  wakeupHistory: () => app().LocalCodexWakeupHistory() as Promise<WakeupRunEntry[]>,
  instanceList: () => app().LocalInstanceList('codex') as Promise<InstanceProfile[]>,
  instanceCreate: (n, d, w, e, b) => app().LocalInstanceCreate('codex', n, d, w, e, b) as Promise<InstanceProfile>,
  instanceDelete: (id) => app().LocalInstanceDelete(id) as Promise<void>,
  instanceUpdate: (p) => app().LocalInstanceUpdate(p) as Promise<void>,
  instanceLaunch: (id) => app().LocalInstanceLaunch(id) as Promise<void>,
  instanceStop: (id) => app().LocalInstanceStop(id) as Promise<void>,
  getSource: () => app().LocalGetCodexSource() as Promise<string>,
  setSource: (src) => app().LocalSetCodexSource(src) as Promise<void>,
}

export const antigravityLocalApi: ProviderLocalApi = {
  listAccounts: () => app().LocalListAntigravityAccounts() as Promise<LocalAccountView[]>,
  startLogin: () => app().LocalStartAntigravityLogin() as Promise<string>,
  waitLogin: (id) => app().LocalWaitAntigravityLogin(id) as Promise<LocalAccountView>,
  addByToken: (rt, at, email) => app().LocalAddAntigravityToken(rt, at, email) as Promise<LocalAccountView>,
  addByApiKey: (key, base, email) => app().LocalAddAntigravityApiKey(key, base, email) as Promise<LocalAccountView>,
  setPoolEnabled: (id, e) => app().LocalSetPoolEnabled(id, e) as Promise<void>,
  setPriority: (id) => app().LocalSetAntigravityPriority(id) as Promise<void>,
  refreshQuota: (id) => app().LocalRefreshAccountQuota(id) as Promise<void>,
  refreshAllQuotas: () => app().LocalRefreshAllQuotas('antigravity') as Promise<number>,
  rename: (id, name) => app().LocalRenameAccount(id, name) as Promise<void>,
  setNote: (id, note) => app().LocalSetAccountNote(id, note) as Promise<void>,
  setTags: (id, tags) => app().LocalSetAccountTags(id, tags) as Promise<void>,
  deleteAccount: (id) => app().LocalDeleteAccount(id) as Promise<void>,
  deleteAccounts: (ids) => app().LocalDeleteAccounts(ids) as Promise<void>,
  gatewayStart: () => app().LocalAntigravityGatewayStart() as Promise<LocalGatewayStatus>,
  gatewayStop: () => app().LocalAntigravityGatewayStop() as Promise<void>,
  gatewayStatus: () => app().LocalAntigravityGatewayStatus() as Promise<LocalGatewayStatus>,
  setGatewayPort: (port) => app().LocalSetGatewayPort(port) as Promise<LocalGatewayStatus>,
  stats: () => app().LocalAntigravityStats() as Promise<LocalStatsSnapshot>,
  exportAccounts: (ids) => app().LocalExportAntigravityAccounts(ids) as Promise<string>,
  importFromJSON: (json) => app().LocalImportAntigravityFromJSON(json) as Promise<number>,
  importAuthFiles: (contents) => app().LocalImportAntigravityAuthFiles(contents) as Promise<number>,
  syncFromIDE: () => app().LocalSyncAntigravityFromIDE() as Promise<number>,
  wakeupConfig: () => app().LocalAntigravityWakeupConfig() as Promise<WakeupConfig>,
  setWakeupConfig: (e, i) => app().LocalSetAntigravityWakeupConfig(e, i) as Promise<void>,
  wakeupRunNow: () => app().LocalAntigravityWakeupRunNow() as Promise<WakeupRunEntry[]>,
  wakeupHistory: () => app().LocalAntigravityWakeupHistory() as Promise<WakeupRunEntry[]>,
  instanceList: () => app().LocalInstanceList('antigravity') as Promise<InstanceProfile[]>,
  instanceCreate: (n, d, w, e, b) => app().LocalInstanceCreate('antigravity', n, d, w, e, b) as Promise<InstanceProfile>,
  instanceDelete: (id) => app().LocalInstanceDelete(id) as Promise<void>,
  instanceUpdate: (p) => app().LocalInstanceUpdate(p) as Promise<void>,
  instanceLaunch: (id) => app().LocalInstanceLaunch(id) as Promise<void>,
  instanceStop: (id) => app().LocalInstanceStop(id) as Promise<void>,
  getSource: () => app().LocalGetAntigravitySource() as Promise<string>,
  setSource: (src) => app().LocalSetAntigravitySource(src) as Promise<void>,
}

// ── 自动刷新间隔(全局,非 provider 特定) ──

/** 读取自动刷新间隔(配额自动刷新 / 当前账号刷新,分钟)。 */
export function getRefreshConfig(): Promise<RefreshConfig> {
  return app().LocalGetRefreshConfig() as Promise<RefreshConfig>
}

/** 设置自动刷新间隔(分钟),返回 clamp 后的实际配置。 */
export function setRefreshConfig(quotaMinutes: number, currentMinutes: number): Promise<RefreshConfig> {
  return app().LocalSetRefreshConfig(quotaMinutes, currentMinutes) as Promise<RefreshConfig>
}

// ── 反代(codex 网关)运营(全局,非 provider 特定;网关只服务 codex) ──

/** 读取当前路由(选号)策略。 */
export function getRoutingStrategy(): Promise<RoutingStrategy> {
  return app().LocalGetRoutingStrategy() as Promise<RoutingStrategy>
}

/** 设置路由策略(priority / round-robin / fair),热切换到运行中的网关。 */
export function setRoutingStrategy(strategy: RoutingStrategy): Promise<void> {
  return app().LocalSetRoutingStrategy(strategy) as Promise<void>
}

/** 列出客户端访问 key。 */
export function listGatewayKeys(): Promise<GatewayKey[]> {
  return app().LocalListGatewayKeys() as Promise<GatewayKey[]>
}

/** 新建一条访问 key(重启网关生效)。 */
export function createGatewayKey(name: string): Promise<GatewayKey> {
  return app().LocalCreateGatewayKey(name) as Promise<GatewayKey>
}

/** 删除一条访问 key(重启网关生效)。 */
export function deleteGatewayKey(id: string): Promise<void> {
  return app().LocalDeleteGatewayKey(id) as Promise<void>
}

/** 重置一条访问 key 的值(保留 id/名称;重启网关生效)。 */
export function rotateGatewayKey(id: string): Promise<GatewayKey> {
  return app().LocalRotateGatewayKey(id) as Promise<GatewayKey>
}

/** 读取局域网范围(local=仅本机 / lan=局域网)。 */
export function getGatewayAccessScope(): Promise<GatewayAccessScope> {
  return app().LocalGetGatewayAccessScope() as Promise<GatewayAccessScope>
}

/** 设置局域网范围(改网关绑定主机,重启生效)。 */
export function setGatewayAccessScope(scope: GatewayAccessScope): Promise<void> {
  return app().LocalSetGatewayAccessScope(scope) as Promise<void>
}

/** 分页 + 过滤查询请求日志(新→旧)。 */
export function queryGatewayLogs(offset: number, limit: number, filter?: GatewayLogFilter): Promise<GatewayLogPage> {
  return app().LocalQueryGatewayLogs(offset, limit, filter ? JSON.stringify(filter) : '') as Promise<GatewayLogPage>
}

/** 清空网关统计与请求日志。 */
export function clearGatewayStats(): Promise<void> {
  return app().LocalClearGatewayStats() as Promise<void>
}

/** 对本地网关发一个最小真请求,返回连通结果。 */
export function gatewayConnTest(): Promise<GatewayConnTestResult> {
  return app().LocalGatewayConnTest() as Promise<GatewayConnTestResult>
}

// ── 自定义模型供应商(codex OpenAI 兼容供应商)+ 动态模型目录 ──
// 自包含:类型与函数均独立,移植自 cockpit codex_model_provider。
// 红线:这是自定义供应商喂号路径,与远程租号无关。

/** 协议线格式:responses=OpenAI Responses(codex 原生)/ chat_completions=OpenAI 兼容。 */
export type ModelProviderWireApi = 'responses' | 'chat_completions'

/** 一条自定义模型供应商。 */
export interface ModelProvider {
  id: string
  name: string
  baseURL: string
  apiKey: string
  wireApi: ModelProviderWireApi
  modelCatalog: string[]
  createdAt: number
}

/** 新建/更新供应商的入参(id 为空表示新建;wireApi 留空由后端按 baseURL 归一)。 */
export interface ModelProviderInput {
  id?: string
  name: string
  baseURL: string
  apiKey: string
  wireApi?: ModelProviderWireApi | ''
  modelCatalog?: string[]
  createdAt?: number
}

/** 供应商连通测试结果(形状对齐网关 ConnTest)。 */
export interface ModelProviderConnTestResult {
  ok: boolean
  status: number
  latencyMs: number
  err: string
  model: string
}

/** 动态目录里的一条模型。 */
export interface ModelProviderModel {
  id: string
  displayName?: string
}

/** ListModels 返回:目录 + 时延。 */
export interface ModelProviderModelsResult {
  models: ModelProviderModel[]
  latencyMs: number
}

/** 列出全部自定义模型供应商(按 createdAt 升序)。 */
export function listModelProviders(): Promise<ModelProvider[]> {
  return app().LocalListModelProviders() as Promise<ModelProvider[]>
}

/** 新增/更新一条供应商(按 id upsert),返回落盘后的记录。 */
export function saveModelProvider(p: ModelProviderInput): Promise<ModelProvider> {
  return app().LocalSaveModelProvider(p) as Promise<ModelProvider>
}

/** 按 id 删除一条供应商(幂等)。 */
export function deleteModelProvider(id: string): Promise<void> {
  return app().LocalDeleteModelProvider(id) as Promise<void>
}

/** 对某供应商 /models 端点发最小真请求,返回连通结果。 */
export function testModelProvider(id: string): Promise<ModelProviderConnTestResult> {
  return app().LocalTestModelProvider(id) as Promise<ModelProviderConnTestResult>
}

/** 拉某供应商动态模型目录(后端会回写到 provider.modelCatalog)。 */
export function listModelProviderModels(id: string): Promise<ModelProviderModelsResult> {
  return app().LocalListModelProviderModels(id) as Promise<ModelProviderModelsResult>
}

// ── 经济与自动化(① 超额预警 ② 自动切号 ③ 速度档) ──
// 自包含:类型与函数均独立,移植自 cockpit codex_account / codex_speed。
// 红线:自动切号只动 codex 自有号优先级与本机注入,与远程租号无关。

/** ① 超额预警配置:thresholdPct 为「剩余」百分比阈值(0..100),当前号任一窗口剩余 <= 阈值即报。 */
export interface AlertConfig {
  enabled: boolean
  thresholdPct: number
}

/** 超额预警判定结果(纯判定,前端负责派发/节流)。 */
export interface AlertResult {
  Alert: boolean
  LowestPercentage: number
  LowModels: string[] | null
}

/** ② 自动切号监控范围:all=全部号 / selected=仅选中的号。 */
export type SwitchScopeMode = 'all' | 'selected'

/** 自动切号配置:命中阈值/冷却即切到「所有窗口剩余 > 阈值且未冷却」的更空闲号。 */
export interface SwitchConfig {
  enabled: boolean
  thresholdPct: number
  scopeMode: SwitchScopeMode
  selectedAccountIds: string[] | null
}

/** ③ 上下文窗口/压缩阈值预设。 */
export type ContextPreset = 'default' | 'preset_516k' | 'preset_1m' | 'custom'

/** 官方 App 推理速度档:standard=默认(删 service tier 键) / fast=priority。 */
export type ServiceTier = 'standard' | 'fast'

/** 统一速度档配置:上下文预设(+ 自定义值)+ service tier。 */
export interface AppSpeed {
  contextPreset: ContextPreset
  tier: ServiceTier
  customContextWindow?: number
  customAutoCompact?: number
}

/** 读取超额预警配置。 */
export function getAlertConfig(): Promise<AlertConfig> {
  return app().LocalGetAlertConfig() as Promise<AlertConfig>
}

/** 保存超额预警配置,返回 clamp 后的实际值。 */
export function setAlertConfig(cfg: AlertConfig): Promise<AlertConfig> {
  return app().LocalSetAlertConfig(cfg) as Promise<AlertConfig>
}

/** 对 codex 当前(优先级)号求一次预警判定(纯判定,不派发)。 */
export function evaluateCodexAlert(): Promise<AlertResult> {
  return app().LocalEvaluateCodexAlert() as Promise<AlertResult>
}

/** 读取自动切号配置。 */
export function getSwitchConfig(): Promise<SwitchConfig> {
  return app().LocalGetSwitchConfig() as Promise<SwitchConfig>
}

/** 保存自动切号配置,返回落盘后的值。 */
export function setSwitchConfig(cfg: SwitchConfig): Promise<SwitchConfig> {
  return app().LocalSetSwitchConfig(cfg) as Promise<SwitchConfig>
}

/** 读取速度档配置。 */
export function getAppSpeed(): Promise<AppSpeed> {
  return app().LocalGetAppSpeed() as Promise<AppSpeed>
}

/** 保存速度档配置,返回落盘后的值。 */
export function setAppSpeed(s: AppSpeed): Promise<AppSpeed> {
  return app().LocalSetAppSpeed(s) as Promise<AppSpeed>
}

// ── codex 上游业务(① 订阅 ② 主动重置次数 ③ 邀请返利) ──
// codex 自有号查自己的订阅/返利,等同额度刷新路径;不碰远程租号 / 网关出口。

/** ① 订阅快照。 */
export interface CodexSubscriptionSnapshot {
  AccountID: string
  PlanType: string
  SubscriptionActiveUntil: string
}

/** ② 一条主动重置次数明细。 */
export interface CodexResetCredit {
  id?: string
  status?: string
  reset_type?: string
  granted_at?: number
  expires_at?: number
  redeemed_at?: number
  raw_status?: string
}

/** 主动重置次数快照。 */
export interface CodexResetCreditsSnapshot {
  available_count?: number
  credits: CodexResetCredit[] | null
  next_expires_at?: number
}

/** ③ 邀请返利资格。 */
export interface CodexReferralInviteEligibility {
  should_show: boolean
  remaining_referrals?: number
  ineligible_reason_code?: string
  grant_action?: string
  grant_amount?: number
  referral_key: string
}

/** 邀请返利时间窗规则。 */
export interface CodexReferralTimeFrameRule {
  type: string
  invites_sent: number
  invites_total: number
}

/** 邀请返利规则集。 */
export interface CodexReferralEligibilityRules {
  requires_explicit_confirmation: boolean | null
  rules: string[] | null
  time_frame_rules: CodexReferralTimeFrameRule[] | null
}

/** 一条已发邀请。 */
export interface CodexReferralInvite {
  email: string
}

/** 发邀请响应。 */
export interface CodexReferralInviteResponse {
  invites: CodexReferralInvite[] | null
}

/** 拉某 codex 自有号的订阅快照(accounts/check → subscriptions 回退)。 */
export function refreshCodexSubscription(id: string): Promise<CodexSubscriptionSnapshot> {
  return app().LocalRefreshCodexSubscription(id) as Promise<CodexSubscriptionSnapshot>
}

/** 拉某 codex 自有号的主动重置次数明细。 */
export function getCodexResetCredits(id: string): Promise<CodexResetCreditsSnapshot> {
  return app().LocalGetCodexResetCredits(id) as Promise<CodexResetCreditsSnapshot>
}

/** 消费一次主动重置;redeemRequestID 传空串时后端自动生成 UUID。 */
export function consumeCodexResetCredit(id: string, redeemRequestId = ''): Promise<void> {
  return app().LocalConsumeCodexResetCredit(id, redeemRequestId) as Promise<void>
}

/** 查某 codex 自有号的邀请返利资格(referralKey 空则用后端默认 key)。 */
export function codexReferralEligibility(id: string, referralKey = ''): Promise<CodexReferralInviteEligibility> {
  return app().LocalCodexReferralEligibility(id, referralKey) as Promise<CodexReferralInviteEligibility>
}

/** 查某 codex 自有号的邀请返利规则。 */
export function codexReferralRules(id: string, referralKey = ''): Promise<CodexReferralEligibilityRules> {
  return app().LocalCodexReferralRules(id, referralKey) as Promise<CodexReferralEligibilityRules>
}

/** 给某 codex 自有号发邀请(emails 1..=5,后端 trim/去空/校验)。 */
export function sendCodexReferralInvites(
  id: string,
  emails: string[],
  referralKey = '',
): Promise<CodexReferralInviteResponse> {
  return app().LocalSendCodexReferralInvites(id, referralKey, emails) as Promise<CodexReferralInviteResponse>
}

// ── Codex 设置面板 + config.toml 快捷配置 ──
// 只读写本地 Codex 设置与 config.toml,与远程租号 / 网关出口无关。

/** 「Codex 设置」面板的全部持久化项。 */
export interface CodexSettings {
  codexAppPath: string
  launchOnSwitch: boolean
  restartAppOnSwitch: boolean
  restartAppPath: string
  showApiEntry: boolean
  filterMemory: boolean
  showCodeReviewQuota: boolean
}

/** config.toml 快捷配置视图。 */
export interface CodexQuickConfig {
  contextWindow1m: boolean
  autoCompactTokenLimit: number
  detectedModelContextWindow?: number
  detectedAutoCompactTokenLimit?: number
}

/** 读取「Codex 设置」面板项(缺省回退默认)。 */
export function getCodexSettings(): Promise<CodexSettings> {
  return app().LocalGetCodexSettings() as Promise<CodexSettings>
}

/** 保存「Codex 设置」面板项,返回落盘后的值。 */
export function saveCodexSettings(s: CodexSettings): Promise<CodexSettings> {
  return app().LocalSaveCodexSettings(s) as Promise<CodexSettings>
}

/** 读 ~/.codex/config.toml 的快捷配置。 */
export function getCodexQuickConfig(): Promise<CodexQuickConfig> {
  return app().LocalGetCodexQuickConfig() as Promise<CodexQuickConfig>
}

/**
 * 结构保留地改写 config.toml 两个顶层整数键,回读返回。
 * 传 null 表示删除该键;传正整数表示写入(必须 > 0)。
 */
export function saveCodexQuickConfig(
  modelContextWindow: number | null,
  autoCompactTokenLimit: number | null,
): Promise<CodexQuickConfig> {
  return app().LocalSaveCodexQuickConfig(modelContextWindow, autoCompactTokenLimit) as Promise<CodexQuickConfig>
}

/** 打开系统文件对话框选路径(应用/可执行),取消返回空串。 */
export function browseForPath(title: string): Promise<string> {
  return app().LocalBrowseForPath(title) as Promise<string>
}

/** 自动检测本机 Codex App 路径(未装返回空串)。 */
export function detectCodexAppPath(): Promise<string> {
  return app().LocalDetectCodexAppPath() as Promise<string>
}

/** 用系统默认编辑器打开 ~/.codex/config.toml。 */
export function openCodexConfigToml(): Promise<void> {
  return app().LocalOpenCodexConfigToml() as Promise<void>
}
