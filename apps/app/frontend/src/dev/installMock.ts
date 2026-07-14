// 仅本地预览用:伪造 Wails 绑定(window.go / window.runtime),让前端脱离 Go 后端与真实账号
// 直接跑起来看个人订阅美元额度。只在 VITE_MOCK 下由 main.tsx 动态引入,绝不进生产包。

const now = Date.now()

const account = {
  loggedIn: true,
  email: 'patron@torontomail.com',
  planName: '会员通行证',
  planExpiry: new Date(now + 30 * 86400_000).toISOString(),
  planDeviceMax: 1,
  deviceName: 'MockBook Pro',
  tokenExpiry: '',
  tokenExpired: false,
  sessionUnusable: false,
  subscriptions: [
    {
      id: 'sub-anthropic-T6HM',
      status: 'ACTIVE',
      expiresAt: '',
      deviceLimit: 1,
      priority: 0,
      products: ['anthropic'],
      levels: { anthropic: 'max-20x' },
      usdQuotaByProduct: {
        anthropic: {
          fiveHour: { used: 38.25, limit: 400, resetAt: new Date(now + 4 * 3600_000).toISOString() },
          weekly: { used: 722.4, limit: 2000, resetAt: new Date(now + 6 * 86400_000).toISOString() },
        },
      },
      exclusive: true,
      shareSeats: 1,
    },
    {
      id: 'sub-codex-9Q2X',
      status: 'ACTIVE',
      expiresAt: '',
      deviceLimit: 1,
      priority: 1,
      products: ['codex'],
      levels: { codex: 'pro' },
      usdQuotaByProduct: {
        codex: {
          fiveHour: { used: 105, limit: 200, resetAt: new Date(now + 2 * 3600_000).toISOString() },
          weekly: { used: 512.5, limit: 1750, resetAt: new Date(now + 4 * 86400_000).toISOString() },
        },
      },
      exclusive: false,
      shareSeats: 2,
    },
    {
      id: 'sub-antigravity-7LKA',
      status: 'ACTIVE',
      expiresAt: '',
      deviceLimit: 1,
      priority: 2,
      products: ['antigravity'],
      levels: { antigravity: 'ultra' },
      usdQuotaByProduct: {},
      exclusive: false,
      shareSeats: 1,
    },
  ],
}

const stats = {
  proxyRunning: true,
  proxyPort: 48800,
  stats: {},
  leaser: {
    serviceState: 'running',
    accountId: 101,
    autoLeaseRunning: true,
    cardUnusable: false,
    hasToken: true,
    lastError: '',
    activationExpiresAt: '',
    entitledProducts: ['anthropic', 'codex', 'antigravity'],
    accessKeyStatus: { products: ['anthropic', 'codex', 'antigravity'] },
  },
  today: {
    requests: 128,
    errors: 2,
    inputTokens: 1_250_000,
    outputTokens: 340_000,
    cachedTokens: 890_000,
    cacheWriteTokens: 120_000,
    billableTokens: 700_000,
    generations: 128,
    retries: 0,
    savedMoneyUSD: 47.3,
    byModel: {},
  },
  dailyHistory: [],
  hourlyHistory: [],
  chartMode: 'daily',
  cumulativeSaving: 12_345.67,
  appVersion: 'mock',
  updateStatus: { status: '', version: '', current: '', changelog: '', percent: 0, error: '', canSkip: true },
  proxyStartedAt: new Date(now).toISOString(),
}

const config = {
  accountCard: '', cardExpiry: '', deviceId: 'mock-device', proxyPort: 48800,
  idePath: '', hubPath: '', codexAppPath: '', claudeDesktopPath: '',
  userToken: 'mock-session-token', userTokenExpiry: '', userEmail: account.email,
  planName: '会员通行证', planExpiry: new Date(now + 30 * 86400_000).toISOString(), planDeviceMax: 1, deviceName: 'MockBook Pro',
  codexMode: '', codexRelayBase: '', codexRelayKey: '', codexRelayProtocol: '', codexModelMap: {},
  subscriptions: account.subscriptions,
}

let hostProtectionStatus = {
  mode: 'configure', platform: 'macos', requiresAuthorization: true,
  originalTimezone: 'Asia/Shanghai', currentSystemTimezone: 'Asia/Shanghai', exitTimezone: 'Asia/Singapore', appliedTimezone: '',
  timezoneStrategy: 'follow', timezoneMatch: '', blockWebRTC: true, blockGeolocation: true, dnsCleared: false,
  protectedBrowsers: '', targets: ['claude', 'claude_desktop'], lastError: '',
}

let mockIDEProducts = [
  { id: 'claude_code', name: 'Claude Code', detected: true, detectedPath: '~/.claude', injected: false, supportsInjection: true, injectionType: 'config' },
  { id: 'claude_desktop', name: 'Claude Desktop', detected: true, detectedPath: '/Applications/Claude.app', injected: false, supportsInjection: true, injectionType: 'mitm' },
  { id: 'codex', name: 'Codex', detected: true, detectedPath: '/Applications/Codex.app', injected: false, supportsInjection: true, injectionType: 'config' },
]

const targetProductId = (target: unknown) => target === 'claude' ? 'claude_code' : target === 'claude_desktop' ? 'claude_desktop' : target === 'codex' ? 'codex' : String(target)

// 已知方法给真数据;其余任何 App.* 调用回退到无害的 async()=>null,避免未 mock 的方法炸掉页面。
const appMethods: Record<string, (...args: unknown[]) => Promise<unknown>> = {
  GetAccountState: async () => account,
  GetStats: async () => stats,
  GetConfig: async () => config,
  GetIDEStatus: async () => ({
    products: mockIDEProducts,
    proxyUrl: 'http://127.0.0.1:48800',
    isLsProxyApplied: false,
  }),
  GetAnnouncement: async () => '',
  HeartbeatCheck: async () => ({}),
  GetLogs: async () => [],
  GetAppVersion: async () => 'mock',
  CheckForUpdate: async () => ({}),
  DetectCompetingClaudeConfig: async () => [],
  SanitizeCompetingClaudeConfig: async () => ({ cleaned: [], skipped: [], backupTo: '' }),
  InjectSelected: async (targets) => {
    const ids = (targets as unknown[]).map(targetProductId)
    mockIDEProducts = mockIDEProducts.map((product) => ids.includes(product.id) ? { ...product, injected: true } : product)
    return '✓ 已接管'
  },
  RestoreSelected: async (targets) => {
    const ids = (targets as unknown[]).map(targetProductId)
    mockIDEProducts = mockIDEProducts.map((product) => ids.includes(product.id) ? { ...product, injected: false } : product)
    return '✓ 已恢复'
  },
  GetHostProtectionStatus: async () => hostProtectionStatus,
  ProbeHostProtectionStatus: async (targets) => ({ ...hostProtectionStatus, mode: 'configure', blockWebRTC: true, blockGeolocation: true, targets }),
  ApplyHostProtection: async (value) => {
    const cfg = value as typeof hostProtectionStatus & { fixedTimezone?: string }
    const applied = cfg.timezoneStrategy === 'fixed' ? cfg.fixedTimezone || 'Asia/Singapore' : cfg.timezoneStrategy === 'unchanged' ? hostProtectionStatus.originalTimezone : hostProtectionStatus.exitTimezone
    // 造数据:模拟系统实读结果 —— 改了就对齐到目标(aligned),不改则仍是原时区。
    const current = cfg.timezoneStrategy === 'unchanged' ? hostProtectionStatus.originalTimezone : applied
    hostProtectionStatus = {
      ...hostProtectionStatus,
      ...cfg,
      mode: 'active',
      appliedTimezone: applied,
      currentSystemTimezone: current,
      timezoneMatch: cfg.timezoneStrategy === 'unchanged' ? '' : 'aligned',
      protectedBrowsers: 'chrome×2 edge×1',
      dnsCleared: cfg.timezoneStrategy !== 'unchanged',
    }
    return hostProtectionStatus
  },
  RestoreHostProtection: async () => {
    hostProtectionStatus = { ...hostProtectionStatus, mode: 'restored', appliedTimezone: hostProtectionStatus.originalTimezone, blockWebRTC: false, blockGeolocation: false }
    return hostProtectionStatus
  },
  ReleaseHostProtectionTarget: async (rawTarget) => {
    const target = String(rawTarget)
    const targets = hostProtectionStatus.targets.filter((item) => item !== target)
    hostProtectionStatus = { ...hostProtectionStatus, mode: targets.length ? 'active' : 'restored', targets }
    return hostProtectionStatus
  },
}

export function installMock() {
  if (typeof window === 'undefined') return
  const w = window as unknown as Record<string, unknown>
  w.go = {
    main: {
      App: new Proxy(appMethods, {
        get: (target, prop: string) => {
          if (prop in target) return target[prop]
          if (/List|History|Accounts|Models|Sessions/.test(prop)) return async () => []
          if (/GatewayStatus/.test(prop)) return async () => ({ running: false, addr: '', port: 8317 })
          if (/Get.*Source/.test(prop)) return async () => 'remote'
          if (/Stats/.test(prop)) return async () => ({ totalRequests: 0, totalFailed: 0, totalInputTokens: 0, totalOutputTokens: 0, byAccount: [], byModel: [], recent: [] })
          if (/Config/.test(prop)) return async () => ({ enabled: false, intervalMinutes: 30 })
          return async () => null
        },
      }),
    },
  }
  // runtime.*(BrowserOpenURL/EventsOn 等)一律无害 noop。
  w.runtime = new Proxy({}, { get: () => () => undefined })
}
