/**
 * 冰茶AI Electron 主进程
 * 功能：窗口管理 + 系统托盘 + IPC 通信 + token-proxy 进程管理
 */
import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, shell } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as http from 'http'
import * as crypto from 'crypto'
import { spawn, execFileSync } from 'child_process'
import * as net from 'net'
import { autoUpdater, UpdateInfo } from 'electron-updater'
import { setLogger, detectAllProducts, injectProduct, restoreProduct, injectAllDetected, killAndRestartHub } from './ide-products'

// ─── Constants ──────────────────────────────────────────────────────────
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const IS_DEV = !app.isPackaged

const APP_DATA_DIR = IS_WIN
  ? process.env.APPDATA || ''
  : IS_MAC
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')

const ROSETTA_DATA_DIR = path.join(APP_DATA_DIR, 'Antigravity', 'rosetta')
const CONFIG_PATH = path.join(ROSETTA_DATA_DIR, 'proxy.config.json')
const IDE_SETTINGS_PATH = path.join(APP_DATA_DIR, 'Antigravity', 'User', 'settings.json')
const DEFAULT_TOKEN_SERVER_URL = 'https://bcai.site/remote-token'
const PROXY_PORT = 60670
const STATUS_PORT = 60671
const STATUS_URL = `http://127.0.0.1:${STATUS_PORT}/status`
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`
const REFRESH_INTERVAL_MS = 3000

// ─── Globals ────────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null
let currentState: any = null
let isQuitting = false
let updateStatus: any = null

// ─── Stable Client ID ───────────────────────────────────────────────────
// 基于机器特征生成稳定的 clientId，防止重启后被服务端判定为"其他设备"
function getStableClientId(): string {
  const raw = `${os.hostname()}|${os.userInfo().username}|${os.platform()}|${os.arch()}`
  const hash = crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16)
  return `bcai-${hash}`
}

// ─── Helpers ────────────────────────────────────────────────────────────
function log(msg: string): void {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  console.log(`[${ts}] ${msg}`)
}
setLogger(log)

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function writeJsonFile(filePath: string, value: any): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function fetchJson(urlString: string, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const target = new URL(urlString)
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}`))
            return
          }
          try { resolve(raw ? JSON.parse(raw) : {}) }
          catch { reject(new Error('Bad JSON')) }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Timeout')))
    req.end()
  })
}

// ─── Bundled Rosetta path ───────────────────────────────────────────────
function getBundledRosettaPath(): string {
  if (IS_DEV) {
    // 开发模式：从 gfa-extension 读取
    const devPath = path.join(__dirname, '..', '..', '..', 'gfa-extension', 'bundled-rosetta')
    if (fs.existsSync(devPath)) return devPath
  }
  // 打包后：resources 目录
  if (process.resourcesPath) {
    const pkgPath = path.join(process.resourcesPath, 'bundled-rosetta')
    if (fs.existsSync(pkgPath)) return pkgPath
  }
  return ''
}

// ─── Node binary resolution ────────────────────────────────────────────
function resolveNodeBinary(): string {
  // 1. 打包的独立 node
  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'node-runtime', IS_WIN ? 'node.exe' : 'node')
    if (fs.existsSync(bundled)) return bundled
  }
  // 2. 系统 PATH 里的 node
  try {
    const cmd = IS_WIN ? 'where.exe' : 'which'
    const output = execFileSync(cmd, ['node'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    const firstLine = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0]
    if (firstLine) {
      execFileSync(firstLine, ['-v'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      return firstLine
    }
  } catch { /* ignore */ }
  // 3. 兜底
  return 'node'
}

// ─── Config management ─────────────────────────────────────────────────
function readConfig(): any {
  return readJsonFile(CONFIG_PATH, {})
}

function updateConfig(updater: (config: any) => any): any {
  const current = readConfig()
  const next = updater({ ...current })
  writeJsonFile(CONFIG_PATH, next)
  return next
}

// ─── IDE settings ───────────────────────────────────────────────────────
function readIdeCloudCodeUrl(): string {
  try {
    if (!fs.existsSync(IDE_SETTINGS_PATH)) return ''
    const raw = fs.readFileSync(IDE_SETTINGS_PATH, 'utf8')
    // Strip JSON comments
    const cleaned = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1')
    const settings = JSON.parse(cleaned)
    return String(settings['jetski.cloudCodeUrl'] || '').trim()
  } catch {
    return ''
  }
}

function writeIdeCloudCodeUrl(url: string): void {
  let settings: any = {}
  if (fs.existsSync(IDE_SETTINGS_PATH)) {
    try {
      const raw = fs.readFileSync(IDE_SETTINGS_PATH, 'utf8')
      const cleaned = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1')
      settings = JSON.parse(cleaned)
    } catch { settings = {} }
  }
  if (url) {
    settings['jetski.cloudCodeUrl'] = url.trim()
  } else {
    delete settings['jetski.cloudCodeUrl']
  }
  fs.mkdirSync(path.dirname(IDE_SETTINGS_PATH), { recursive: true })
  fs.writeFileSync(IDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8')
}

// ─── Proxy process management ──────────────────────────────────────────
async function isProxyRunning(): Promise<boolean> {
  try {
    const status = await fetchJson(STATUS_URL)
    return Boolean(status?.running)
  } catch {
    return false
  }
}

async function getProxyStatus(): Promise<any> {
  try {
    return await fetchJson(STATUS_URL)
  } catch {
    return { running: false }
  }
}

function spawnTokenProxy(): number | undefined {
  const rosettaPath = getBundledRosettaPath()
  if (!rosettaPath) {
    log('[ERROR] bundled-rosetta not found')
    return undefined
  }
  const scriptPath = path.join(rosettaPath, 'token-proxy', 'index.js')
  if (!fs.existsSync(scriptPath)) {
    log(`[ERROR] start script not found: ${scriptPath}`)
    return undefined
  }

  const nodeBinary = resolveNodeBinary()
  log(`[spawn] node=${nodeBinary} script=${scriptPath}`)

  const stableClientId = getStableClientId()
  log(`[spawn] clientId=${stableClientId}`)
  const child = spawn(nodeBinary, [scriptPath], {
    cwd: rosettaPath,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, BCAI_RELAY_CLIENT_ID: stableClientId },
  })
  child.on('error', (err) => log(`[spawn error] ${err.message}`))
  child.unref()
  lastSpawnedPid = child.pid
  log(`[spawn] PID=${child.pid}`)
  return child.pid
}

async function stopTokenProxy(): Promise<void> {
  try {
    await fetchJson(`http://127.0.0.1:${STATUS_PORT}/shutdown`, 5000)
  } catch {
    // 如果 /shutdown 不支持，尝试杀进程
    try {
      const status = await fetchJson(STATUS_URL)
      if (status?.pid) {
        process.kill(Number(status.pid))
      }
    } catch { /* best effort */ }
  }
}

async function waitForProxy(timeoutMs = 15000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isProxyRunning()) return true
    await new Promise(r => setTimeout(r, 400))
  }
  return false
}

// ─── Port conflict detection ────────────────────────────────────────────
let lastSpawnedPid: number | undefined = undefined

function checkPortConflict(proxyStatus: any): { port: number; mode: string } | null {
  // 如果端口上有进程在跑，但不是我们启动的 relay 模式进程，就是冲突
  if (!proxyStatus?.running) return null
  const mode = String(proxyStatus?.mode || '').toLowerCase()
  const isOurRelay = mode === 'token-passthrough' || mode === 'relay'
  // 如果是 relay 模式，不冲突（可能是我们启动的或上次启动的）
  if (isOurRelay) return null
  // 有其他进程在用这个端口（比如插件的本地号池模式）
  return { port: PROXY_PORT, mode: mode || 'local' }
}

// ─── State collection ───────────────────────────────────────────────────
async function collectState(): Promise<any> {
  const config = readConfig()
  const proxyStatus = await getProxyStatus()
  const configuredUrl = readIdeCloudCodeUrl()

  // 判断是否是 relay 模式
  const isRelay = proxyStatus?.mode === 'token-passthrough' || proxyStatus?.mode === 'relay'
  const relayHasApiKey = Boolean(
    String(config?.relayProxy?.apiKey || config?.relayProxy?.tokenServerSecret || '').trim()
  )

  // 端口冲突检测
  const portConflict = checkPortConflict(proxyStatus)

  return {
    ready: true,
    distribution: 'client',
    config,
    portConflict,
    proxy: {
      running: Boolean(proxyStatus?.running),
      totalRequests: Number(proxyStatus?.totalRequests || 0),
      totalRotations: Number(proxyStatus?.totalRotations || 0),
      activeEmail: String(proxyStatus?.activeEmail || ''),
      url: PROXY_URL,
      outbound: proxyStatus?.outbound || null,
    },
    relay: {
      running: Boolean(proxyStatus?.running && isRelay),
      url: PROXY_URL,
      hasApiKey: relayHasApiKey,
      totalRequests: isRelay ? Number(proxyStatus?.totalRequests || 0) : 0,
      totalErrors: isRelay ? Number(proxyStatus?.totalErrors || 0) : 0,
      totalInputTokens: isRelay ? Number(proxyStatus?.totalInputTokens || 0) : 0,
      totalOutputTokens: isRelay ? Number(proxyStatus?.totalOutputTokens || 0) : 0,
      lastError: isRelay ? (proxyStatus?.lastRemoteError || proxyStatus?.lastError || null) : null,
      accessKeyStatus: isRelay ? (proxyStatus?.accessKeyStatus || null) : null,
      serviceStatus: computeServiceStatus(isRelay && proxyStatus?.running, relayHasApiKey, configuredUrl === PROXY_URL, proxyStatus),
    },
    ide: {
      configuredUrl,
      expectedUrl: PROXY_URL,
      isConfigured: configuredUrl === PROXY_URL,
    },
    ideProducts: detectAllProducts(PROXY_PORT),
    accounts: [],
  }
}

function computeServiceStatus(running: boolean, hasApiKey: boolean, ideConfigured: boolean, status: any) {
  const errMsg = String(status?.lastRemoteError || status?.lastError || '').trim()
  const errLow = errMsg.toLowerCase()

  if (!hasApiKey) return { code: 'missing_key', label: '未配置卡密', detail: '请先设置卡密。', tone: 'warning' }
  if (!running) return { code: 'stopped', label: '未开启', detail: '续杯尚未启动。', tone: 'muted' }
  if (!ideConfigured) return { code: 'ide_detached', label: 'IDE 未接入', detail: '续杯已启动，但 IDE 还没接入。', tone: 'warning' }
  if (errMsg) {
    if (errLow.includes('invalid access key') || errLow.includes('unauthorized')) return { code: 'invalid_key', label: '卡密不可用', detail: errMsg, tone: 'bad' }
    if (errLow.includes('already active') || errLow.includes('another device')) return { code: 'key_in_use', label: '卡密正在其他设备使用', detail: errMsg, tone: 'bad' }
    if (errLow.includes('upgrade') || errLow.includes('版本过低')) return { code: 'upgrade_required', label: '需要升级', detail: errMsg, tone: 'bad' }
    if (errLow.includes('timeout') || errLow.includes('econnreset') || errLow.includes('econnrefused')) return { code: 'server_unreachable', label: '服务器连接异常', detail: errMsg, tone: 'bad' }
    if (errLow.includes('no healthy') || errLow.includes('no token')) return { code: 'pool_unavailable', label: '号池暂不可用', detail: errMsg, tone: 'warning' }
    return { code: 'error', label: '服务异常', detail: errMsg, tone: 'bad' }
  }
  if (Number(status?.remoteLeaseCount || 0) > 0) return { code: 'ok', label: '服务正常', detail: '已成功连接续杯服务。', tone: 'good' }
  return { code: 'waiting_first_lease', label: '等待首次连接', detail: '发送第一条对话后会验证卡密并租用账号。', tone: 'warning' }
}

// ─── IPC Handlers ───────────────────────────────────────────────────────
function setupIpcHandlers(): void {
  ipcMain.on('rosetta-action', async (_event, message) => {
    const { type, payload } = message
    log(`[IPC] ${type}`)

    try {
      switch (type) {
        case 'rosetta:getState': {
          await refreshAndPush()
          break
        }

        case 'rosetta:setRelayKey': {
          const secret = String(payload?.secret || '').trim()
          updateConfig((config) => {
            if (!config.relayProxy) config.relayProxy = {}
            config.relayProxy.tokenServerSecret = secret
            config.relayProxy.apiKey = secret
            return config
          })
          log(`[setRelayKey] key ${secret ? 'set' : 'cleared'}`)

          // 如果续杯正在运行，重启它以使用新卡密
          if (await isProxyRunning()) {
            await stopTokenProxy()
            await new Promise(r => setTimeout(r, 1500))
            startRelay()
          }
          await refreshAndPush()
          break
        }

        case 'rosetta:toggleRelay': {
          const status = await getProxyStatus()
          const isRelay = status?.running && (status?.mode === 'token-passthrough' || status?.mode === 'relay')

          if (isRelay) {
            // ─── 关闭续杯 ─────────────────
            log('[relay:off] stopping...')
            await stopTokenProxy()
            await new Promise(r => setTimeout(r, 1500))

            // 清除 IDE 配置
            // 恢复所有 IDE 产品
            const offStatus = detectAllProducts(PROXY_PORT)
            for (const p of offStatus.products) {
              if (p.injected) {
                const err = restoreProduct(p.id)
                if (err) log(`[relay:off] restore ${p.id} failed: ${err}`)
                else log(`[relay:off] ${p.id} restored`)
              }
            }
            log('[relay:off] all IDE products restored')
          } else {
            // ─── 开启续杯 ─────────────────
            const config = readConfig()
            if (!String(config?.relayProxy?.tokenServerSecret || config?.relayProxy?.apiKey || '').trim()) {
              sendNotification('请先设置卡密')
              break
            }

            // 如果有其他进程占着端口，先停
            if (status?.running) {
              log('[relay:on] stopping existing proxy...')
              await stopTokenProxy()
              await new Promise(r => setTimeout(r, 1500))
            }

            startRelay()
          }
          await refreshAndPush()
          break
        }

        case 'rosetta:openExternal': {
          const url = String(payload?.url || '').trim()
          if (url) shell.openExternal(url)
          break
        }

        case 'rosetta:checkUpdate': {
          autoUpdater.checkForUpdates().catch(() => {})
          break
        }

        case 'rosetta:getUpdateStatus': {
          if (updateStatus) pushUpdateStatus(updateStatus)
          break
        }

        case 'rosetta:getIDEProducts': {
          const products = detectAllProducts(PROXY_PORT)
          mainWindow?.webContents.send('rosetta:ideProducts', products)
          break
        }

        case 'rosetta:injectProduct': {
          const pid = String(payload?.id || '')
          const err = injectProduct(pid, PROXY_PORT)
          if (err) {
            log(`[inject] ${pid} failed: ${err}`)
            sendNotification(`接管失败: ${err}`)
          } else {
            log(`[inject] ${pid} ok`)
            sendNotification(`${pid === 'antigravity_hub' ? 'Hub' : 'IDE'} 已接管`)
            // Hub 注入后需要重启
            if (pid === 'antigravity_hub') killAndRestartHub()
          }
          await refreshAndPush()
          break
        }

        case 'rosetta:restoreProduct': {
          const rid = String(payload?.id || '')
          const rerr = restoreProduct(rid)
          if (rerr) {
            log(`[restore] ${rid} failed: ${rerr}`)
            sendNotification(`恢复失败: ${rerr}`)
          } else {
            log(`[restore] ${rid} ok`)
            sendNotification(`${rid === 'antigravity_hub' ? 'Hub' : 'IDE'} 已恢复`)
            if (rid === 'antigravity_hub') killAndRestartHub()
          }
          await refreshAndPush()
          break
        }

        default:
          log(`[IPC] unknown action: ${type}`)
      }
    } catch (err: any) {
      log(`[IPC ERROR] ${type}: ${err.message}`)
    }
  })
}

function startRelay(): void {
  // 写入 remote 模式配置
  updateConfig((config) => {
    config.tokenProxyMode = 'remote'
    if (!config.relayProxy) config.relayProxy = {}
    if (!config.relayProxy.tokenServerUrl) {
      config.relayProxy.tokenServerUrl = DEFAULT_TOKEN_SERVER_URL
    }
    config.relayProxy.clientVersion = app.getVersion()
    config.relayProxy.clientDistribution = 'client'
    return config
  })

  // 启动 token-proxy
  spawnTokenProxy()

  // 等待启动后写入 IDE 配置
  waitForProxy(15000).then((ok) => {
    if (ok) {
      // 注入所有已检测到的 IDE 产品（IDE: settings.json, Hub: asar patch）
      injectAllDetected(PROXY_PORT)
      log('[relay:on] started + all IDE products injected')

      // 检查 language_server 是否已连到我们的代理（参照 timo 方案）
      if (IS_WIN) {
        try {
          const lsCmdline = execFileSync('wmic', [
            'process', 'where', "name like 'language_server%'",
            'get', 'commandline', '/format:list'
          ], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim()

          if (lsCmdline) {
            const endpointMatch = lsCmdline.match(/--cloud_code_endpoint\s+(\S+)/)
            const currentEndpoint = endpointMatch ? endpointMatch[1] : ''
            if (currentEndpoint === PROXY_URL || currentEndpoint === `${PROXY_URL}/`) {
              log('[relay:on] language_server already connected to proxy, skip restart')
            } else {
              log(`[relay:on] language_server endpoint: ${currentEndpoint || '(default)'}, restarting...`)
              execFileSync('taskkill', ['/IM', 'language_server_windows_x64.exe', '/F'],
                { stdio: 'ignore', windowsHide: true })
              log('[relay:on] language_server killed, IDE will auto-restart it')
            }
          } else {
            log('[relay:on] language_server not running, skip restart')
          }
        } catch {
          log('[relay:on] language_server check failed, skip restart')
        }
      }
      sendNotification('续杯已开启')
    } else {
      log('[relay:on] proxy failed to start')
      sendNotification('续杯启动失败，请检查日志')
    }
    refreshAndPush()
  })
}

// ─── State push ─────────────────────────────────────────────────────────
async function refreshAndPush(): Promise<void> {
  try {
    currentState = await collectState()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('rosetta:state', currentState)
    }
  } catch (err: any) {
    log(`[refresh] error: ${err.message}`)
  }
}

function sendNotification(body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title: '冰茶AI', body }).show()
  }
}

// ─── Window ─────────────────────────────────────────────────────────────
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 680,
    minWidth: 380,
    minHeight: 500,
    title: '冰茶AI',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 开发模式加载 dev server，生产模式加载打包文件
  if (IS_DEV && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  }

  // 关闭窗口 → 最小化到托盘（不退出）
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ─── Tray ───────────────────────────────────────────────────────────────
function createTray(): void {
  // 简单的 16x16 图标（开发模式用默认图标）
  const iconPath = IS_DEV
    ? path.join(__dirname, '..', '..', 'resources', 'tray-icon.png')
    : path.join(process.resourcesPath!, 'tray-icon.png')

  let icon: nativeImage
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath)
  } else {
    // 创建一个简单的占位图标
    icon = nativeImage.createEmpty()
  }

  tray = new Tray(icon.isEmpty() ? nativeImage.createFromBuffer(Buffer.alloc(1)) : icon)
  tray.setToolTip('冰茶AI')

  const contextMenu = Menu.buildFromTemplate([
    { label: '打开', click: () => { mainWindow?.show(); mainWindow?.focus() } },
    { type: 'separator' },
    {
      label: '退出', click: async () => {
        isQuitting = true
        // 停止续杯 + 恢复所有 IDE 产品
        if (await isProxyRunning()) {
          await stopTokenProxy()
          const quitStatus = detectAllProducts(PROXY_PORT)
          for (const p of quitStatus.products) {
            if (p.injected) restoreProduct(p.id)
          }
        }
        app.quit()
      }
    },
  ])
  tray.setContextMenu(contextMenu)
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus() })
}

// ─── Auto Updater ───────────────────────────────────────────────────────
function setupAutoUpdater(): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = {
    info: (msg: any) => log(`[updater] ${msg}`),
    warn: (msg: any) => log(`[updater:warn] ${msg}`),
    error: (msg: any) => log(`[updater:error] ${msg}`),
    debug: (msg: any) => log(`[updater:debug] ${msg}`),
  }

  autoUpdater.on('checking-for-update', () => {
    log('[updater] Checking for updates...')
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log(`[updater] Update available: v${info.version}`)
    pushUpdateStatus({ status: 'downloading', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    log('[updater] Already up to date')
    pushUpdateStatus({ status: 'up-to-date', version: app.getVersion() })
  })

  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress.percent)
    if (pct % 10 === 0) log(`[updater] Download: ${pct}%`)
    pushUpdateStatus({
      status: 'downloading',
      percent: pct,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log(`[updater] Update downloaded: v${info.version} — will install on quit`)
    pushUpdateStatus({ status: 'ready', version: info.version })
    sendNotification(`新版本 v${info.version} 已就绪，下次启动自动更新`)
  })

  autoUpdater.on('error', (err) => {
    log(`[updater] Error: ${err.message}`)
    pushUpdateStatus({ status: 'error', error: err.message })
  })

  // 启动后 8 秒检查，之后每 30 分钟检查
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 8000)
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 30 * 60 * 1000)
}

function pushUpdateStatus(status: any): void {
  updateStatus = status
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('rosetta:updateStatus', status)
  }
}

// ─── App lifecycle ──────────────────────────────────────────────────────
app.whenReady().then(() => {
  log('App starting...')
  log(`Data dir: ${ROSETTA_DATA_DIR}`)
  log(`Config: ${CONFIG_PATH}`)
  log(`IDE settings: ${IDE_SETTINGS_PATH}`)
  log(`Bundled rosetta: ${getBundledRosettaPath()}`)

  // 确保数据目录存在
  fs.mkdirSync(ROSETTA_DATA_DIR, { recursive: true })

  // 初始化默认配置
  if (!fs.existsSync(CONFIG_PATH)) {
    const rosettaPath = getBundledRosettaPath()
    const examplePath = path.join(rosettaPath, 'proxy.config.example.json')
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, CONFIG_PATH)
    } else {
      writeJsonFile(CONFIG_PATH, { tokenProxyMode: 'local', tokenProxyPort: PROXY_PORT })
    }
  }

  setupIpcHandlers()
  createWindow()
  createTray()

  // 启动自动升级（生产模式）
  if (!IS_DEV) {
    setupAutoUpdater()
  }

  // 启动状态轮询
  refreshTimer = setInterval(() => refreshAndPush(), REFRESH_INTERVAL_MS)
  refreshAndPush()
})

app.on('window-all-closed', () => {
  // macOS 上关闭窗口不退出
  if (!IS_MAC) {
    // 不退出，保持托盘
  }
})

app.on('activate', () => {
  if (!mainWindow) createWindow()
  else mainWindow.show()
})

app.on('before-quit', () => {
  isQuitting = true
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
})
