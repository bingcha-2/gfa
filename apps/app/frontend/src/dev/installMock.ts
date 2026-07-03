// 仅本地预览用:伪造 Wails 绑定(window.go / window.runtime),让前端脱离 Go 后端与真实账号
// 直接跑起来看「独享 badge + 充能彩蛋 + 滑跪感谢」效果。只在 VITE_MOCK 下由 main.tsx 动态引入,
// 绝不进生产包。造两条订阅:一条独享 anthropic(出 badge + 单层满血)、一条拼车 codex(无 badge,
// 双层条)作对照。

const now = Date.now()

const account = {
  loggedIn: true,
  email: 'patron@torontomail.com',
  planName: '',
  planExpiry: '',
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
      remainFraction: 1,
      productQuota: {
        anthropic: {
          hourlyPercent: 100,
          weeklyPercent: 100,
          hourlyResetAt: null,
          weeklyResetAt: null,
          myShare: 1,
          exclusive: true, // → 尊贵·独享 badge + 单层「剩余 100%」
        },
      },
    },
    {
      id: 'sub-codex-9Q2X',
      status: 'ACTIVE',
      expiresAt: '',
      deviceLimit: 1,
      priority: 1,
      products: ['codex'],
      levels: { codex: 'pro' },
      remainFraction: 0.42,
      productQuota: {
        codex: {
          hourlyPercent: 68,
          weeklyPercent: 80,
          hourlyResetAt: null,
          weeklyResetAt: null,
          myHourlyFraction: 0.5,
          myWeeklyFraction: 0.6,
          myShare: 0.25,
          exclusive: false, // 拼车对照:无 badge、双层条
        },
      },
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
    entitledProducts: ['anthropic', 'codex'],
    boundAccounts: [
      { product: 'anthropic', accountId: 101, emailHint: 'fl**@torontomail.com', planType: 'max', accessToken: '', expiresAt: now + 3600_000, leasedAt: now },
      { product: 'codex', accountId: 202, emailHint: 'co**@example.com', planType: 'pro', accessToken: '', expiresAt: now + 3600_000, leasedAt: now },
    ],
    accessKeyStatus: { products: ['anthropic', 'codex'] },
  },
  today: {
    requests: 128,
    errors: 2,
    inputTokens: 1_250_000,
    outputTokens: 340_000,
    cachedTokens: 890_000,
    cacheWriteTokens: 120_000,
    billableTokens: 700_000,
    generations: 0,
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
  userToken: '', userTokenExpiry: '', userEmail: account.email,
  planName: '', planExpiry: '', planDeviceMax: 1, deviceName: 'MockBook Pro',
  codexMode: '', codexRelayBase: '', codexRelayKey: '', codexRelayProtocol: '', codexModelMap: {},
  subscriptions: account.subscriptions,
}

// 已知方法给真数据;其余任何 App.* 调用回退到无害的 async()=>null,避免未 mock 的方法炸掉页面。
const appMethods: Record<string, (...args: unknown[]) => Promise<unknown>> = {
  GetAccountState: async () => account,
  GetStats: async () => stats,
  GetConfig: async () => config,
  GetIDEStatus: async () => ({ products: [], proxyUrl: '', isLsProxyApplied: false }),
  GetAnnouncement: async () => '',
  HeartbeatCheck: async () => ({}),
  GetLogs: async () => [],
  GetAppVersion: async () => 'mock',
  CheckForUpdate: async () => ({}),
}

export function installMock() {
  if (typeof window === 'undefined') return
  const w = window as unknown as Record<string, unknown>
  w.go = {
    main: {
      App: new Proxy(appMethods, {
        get: (target, prop: string) => (prop in target ? target[prop] : async () => null),
      }),
    },
  }
  // runtime.*(BrowserOpenURL/EventsOn 等)一律无害 noop。
  w.runtime = new Proxy({}, { get: () => () => undefined })
}
