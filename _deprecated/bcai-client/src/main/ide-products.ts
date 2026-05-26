/**
 * IDE 产品检测、注入、恢复模块
 * 支持: Antigravity IDE (settings.json), Antigravity Hub (asar patch), CLI (env)
 * 参考: timo (Tauri/Rust), code-relay-desktop (Go/Wails)
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFileSync, spawn } from 'child_process'

const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

const APP_DATA = IS_WIN
  ? (process.env.APPDATA || '')
  : IS_MAC
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'))

const LOCAL_APP_DATA = IS_WIN ? (process.env.LOCALAPPDATA || '') : ''
const PROGRAM_FILES = IS_WIN ? (process.env.ProgramFiles || 'C:\\Program Files') : ''

// ─── Types ──────────────────────────────────────────────────────────────
export interface IDEProduct {
  id: 'antigravity_ide' | 'antigravity_hub' | 'antigravity_cli'
  name: string
  detected: boolean
  detectedPath: string
  injected: boolean
  injectionType: 'settings' | 'asar' | 'env'
  running: boolean
}

export interface IDEStatus {
  products: IDEProduct[]
  proxyUrl: string
}

let _log: (msg: string) => void = console.log
export function setLogger(fn: (msg: string) => void): void { _log = fn }

// ─── Path Detection ─────────────────────────────────────────────────────
function fileExists(p: string): boolean {
  try { return p !== '' && fs.existsSync(p) } catch { return false }
}

function detectIDEPath(): string {
  if (IS_WIN) {
    const candidates = [
      path.join(LOCAL_APP_DATA, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe'),
      path.join(LOCAL_APP_DATA, 'Programs', 'Kiro', 'Kiro.exe'),
      path.join(PROGRAM_FILES, 'Antigravity IDE', 'Antigravity IDE.exe'),
      path.join(PROGRAM_FILES, 'Kiro', 'Kiro.exe'),
    ]
    for (const p of candidates) { if (fileExists(p)) return p }
  } else if (IS_MAC) {
    const candidates = ['/Applications/Antigravity IDE.app', '/Applications/Kiro.app']
    for (const p of candidates) { if (fileExists(p)) return p }
  } else {
    const candidates = [
      '/usr/share/antigravity-ide/antigravity-ide',
      '/usr/share/kiro/kiro',
      '/opt/Antigravity IDE/antigravity-ide',
    ]
    for (const p of candidates) { if (fileExists(p)) return p }
  }
  return ''
}

function detectHubPath(): string {
  if (IS_WIN) {
    const candidates = [
      path.join(LOCAL_APP_DATA, 'Programs', 'Antigravity', 'Antigravity.exe'),
      path.join(PROGRAM_FILES, 'Antigravity', 'Antigravity.exe'),
    ]
    for (const p of candidates) {
      if (fileExists(p)) return path.dirname(p)
    }
  } else if (IS_MAC) {
    if (fileExists('/Applications/Antigravity.app')) return '/Applications/Antigravity.app'
  } else {
    const candidates = ['/opt/Antigravity/antigravity', '/usr/share/antigravity/antigravity']
    for (const p of candidates) {
      if (fileExists(p)) return path.dirname(p)
    }
  }
  return ''
}

function detectCLIPath(): string {
  if (IS_WIN) {
    const candidates = [
      path.join(LOCAL_APP_DATA, 'Programs', 'Antigravity CLI', 'antigravity.exe'),
      path.join(PROGRAM_FILES, 'Antigravity CLI', 'antigravity.exe'),
    ]
    for (const p of candidates) { if (fileExists(p)) return p }
  } else if (IS_MAC) {
    const candidates = ['/usr/local/bin/antigravity', '/opt/homebrew/bin/antigravity']
    for (const p of candidates) { if (fileExists(p)) return p }
  } else {
    const candidates = ['/usr/bin/antigravity', '/usr/local/bin/antigravity']
    for (const p of candidates) { if (fileExists(p)) return p }
  }
  return ''
}

function getAsarPath(hubPath: string): string {
  if (IS_MAC) return path.join(hubPath, 'Contents', 'Resources', 'app.asar')
  return path.join(hubPath, 'resources', 'app.asar')
}

function getIDESettingsPath(): string {
  if (IS_WIN) return path.join(APP_DATA, 'Antigravity', 'User', 'settings.json')
  if (IS_MAC) return path.join(APP_DATA, 'Antigravity IDE', 'User', 'settings.json')
  return path.join(APP_DATA, 'Antigravity IDE', 'User', 'settings.json')
}

// ─── Process Detection ──────────────────────────────────────────────────
function isProcessRunning(names: string[]): boolean {
  try {
    if (IS_WIN) {
      for (const name of names) {
        try {
          const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'],
            { encoding: 'utf8', windowsHide: true, timeout: 3000 })
          // tasklist 在中文 Windows 返回 "没有运行的任务" 而非 "No tasks"
          // 如果输出包含进程名说明找到了
          if (out.toLowerCase().includes(name.toLowerCase())) return true
        } catch { /* tasklist failed for this name, try next */ }
      }
    } else {
      for (const name of names) {
        try {
          const out = execFileSync('pgrep', ['-f', name],
            { encoding: 'utf8', timeout: 3000 }).trim()
          if (out) return true
        } catch { /* not found */ }
      }
    }
  } catch { /* outer safety net */ }
  return false
}

// ─── Asar patch status cache (avoid reading large file every poll) ───────
let _asarPatchCache: { path: string; mtime: number; patched: boolean } | null = null

// ─── Settings.json Injection (IDE) ──────────────────────────────────────
const CLOUD_CODE_KEY = 'jetski.cloudCodeUrl'

function checkSettingsInjected(settingsPath: string, proxyUrl: string): boolean {
  try {
    if (!fs.existsSync(settingsPath)) return false
    const raw = fs.readFileSync(settingsPath, 'utf8')
    const cleaned = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1')
    const s = JSON.parse(cleaned)
    return s[CLOUD_CODE_KEY] === proxyUrl
  } catch { return false }
}

export function injectIDESettings(proxyUrl: string): void {
  const settingsPath = getIDESettingsPath()
  let settings: any = {}
  if (fs.existsSync(settingsPath)) {
    try {
      const raw = fs.readFileSync(settingsPath, 'utf8')
      const cleaned = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1')
      settings = JSON.parse(cleaned)
    } catch { settings = {} }
  }
  settings[CLOUD_CODE_KEY] = proxyUrl
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  _log(`[ide-products] IDE settings injected: ${CLOUD_CODE_KEY} = ${proxyUrl}`)
}

export function restoreIDESettings(): void {
  const settingsPath = getIDESettingsPath()
  if (!fs.existsSync(settingsPath)) return
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8')
    const cleaned = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1')
    const settings = JSON.parse(cleaned)
    delete settings[CLOUD_CODE_KEY]
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8')
    _log('[ide-products] IDE settings restored')
  } catch (e: any) {
    _log(`[ide-products] IDE settings restore failed: ${e.message}`)
  }
}

// ─── ASAR Patch (Hub) ───────────────────────────────────────────────────
// 参考 code-relay-desktop ide_inject.go 的完整实现

interface AsarFileEntry {
  offset?: string
  size?: number
  files?: Record<string, AsarFileEntry>
  unpacked?: boolean
}

function readAsarJS(asarData: Buffer): {
  jsContent: string; headerPickleSize: number; dataOffset: number
  jsAbsOffset: number; jsOrigSize: number
  header: { files: Record<string, AsarFileEntry> }
  lsEntry: AsarFileEntry
} {
  if (asarData.length < 16) throw new Error('asar file too small')

  const headerPickleSize = asarData.readUInt32LE(4)
  const headerStringSize = asarData.readUInt32LE(12)
  const headerStart = 16
  const headerEnd = headerStart + headerStringSize

  if (asarData.length < headerEnd) throw new Error('asar header extends beyond file')

  let headerStr = asarData.subarray(headerStart, headerEnd).toString('utf8')
  headerStr = headerStr.replace(/\0+$/, '')

  const header = JSON.parse(headerStr) as { files: Record<string, AsarFileEntry> }

  // Navigate: files → dist → files → languageServer.js
  const distEntry = header.files['dist']
  if (!distEntry?.files) throw new Error('dist directory not found in asar header')
  const lsEntry = distEntry.files['languageServer.js']
  if (!lsEntry) throw new Error('dist/languageServer.js not found in asar header')
  if (!lsEntry.offset || !lsEntry.size) throw new Error('languageServer.js offset/size invalid')

  const fileOffset = parseInt(lsEntry.offset, 10)
  const jsOrigSize = lsEntry.size

  // data starts after pickle header (aligned to 4 bytes)
  let dataOffset = 8 + headerPickleSize
  if (dataOffset % 4 !== 0) dataOffset += 4 - (dataOffset % 4)

  const jsAbsOffset = dataOffset + fileOffset
  if (asarData.length < jsAbsOffset + jsOrigSize) {
    throw new Error('languageServer.js extends beyond asar file')
  }

  const jsContent = asarData.subarray(jsAbsOffset, jsAbsOffset + jsOrigSize).toString('utf8')
  return { jsContent, headerPickleSize, dataOffset, jsAbsOffset, jsOrigSize, header, lsEntry }
}

function updateOffsets(files: Record<string, AsarFileEntry>, changedOffset: number, sizeDiff: number): void {
  for (const v of Object.values(files)) {
    if (v.files) { updateOffsets(v.files, changedOffset, sizeDiff); continue }
    if (!v.offset) continue
    const off = parseInt(v.offset, 10)
    if (off > changedOffset) v.offset = String(off + sizeDiff)
  }
}

function rebuildAsar(
  origAsar: Buffer, header: { files: Record<string, AsarFileEntry> },
  newJsBytes: Buffer, jsRelOffset: number, jsOrigSize: number,
  dataOffset: number, headerPickleSize: number
): Buffer {
  // Serialize new header
  const newHeaderJSON = Buffer.from(JSON.stringify(header))
  const newHeaderSize = newHeaderJSON.length

  // Rebuild pickle header area (16 bytes meta + header string)
  const newHeaderArea = Buffer.alloc(16 + newHeaderSize)
  newHeaderArea.writeUInt32LE(4, 0)                      // pickle header prefix size
  newHeaderArea.writeUInt32LE(newHeaderSize + 8, 4)       // pickle total size
  newHeaderArea.writeUInt32LE(4, 8)                       // string header prefix
  newHeaderArea.writeUInt32LE(newHeaderSize, 12)          // string size
  newHeaderJSON.copy(newHeaderArea, 16)

  // Rebuild data area
  const origDataStart = dataOffset
  const beforeJs = origAsar.subarray(origDataStart, origDataStart + jsRelOffset)
  const afterJsStart = origDataStart + jsRelOffset + jsOrigSize
  const afterJs = origAsar.subarray(afterJsStart)

  return Buffer.concat([newHeaderArea, beforeJs, newJsBytes, afterJs])
}

export function patchAsar(proxyPort: number): string {
  const hubPath = detectHubPath()
  if (!hubPath) return 'Antigravity Hub 未检测到'

  const asarPath = getAsarPath(hubPath)
  if (!fileExists(asarPath)) return `app.asar not found: ${asarPath}`

  const proxyUrl = `http://127.0.0.1:${proxyPort}`
  const backupPath = asarPath + '.bak'

  try {
    const asarData = fs.readFileSync(asarPath) as Buffer
    const { jsContent, headerPickleSize, dataOffset, jsAbsOffset, jsOrigSize, header, lsEntry } = readAsarJS(asarData)

    let newJs = jsContent
    let replaced = false

    // 1. 替换已知 Google 原始 URL
    const knownURLs = [
      'https://cloudcode-pa.googleapis.com',
      'https://daily-cloudcode-pa.googleapis.com',
      'https://generativelanguage.googleapis.com',
    ]
    for (const u of knownURLs) {
      if (newJs.includes(u)) {
        newJs = newJs.split(u).join(proxyUrl)
        replaced = true
      }
    }

    // 2. 替换 args 中的 --api_server_url / --cloud_code_endpoint
    const argRe = /('--(?:api_server_url|cloud_code_endpoint)',\s*')([^']+)(')/g
    if (argRe.test(newJs)) {
      newJs = newJs.replace(argRe, `$1${proxyUrl}$3`)
      replaced = true
    }

    // 3. 替换 env['CLOUD_CODE_URL'] 和 env['UNLEASH_URL']
    const envRe = /(env\['(?:CLOUD_CODE_URL|UNLEASH_URL)'\]\s*=\s*')([^']+)(')/g
    if (envRe.test(newJs)) {
      newJs = newJs.replace(envRe, `$1${proxyUrl}$3`)
      replaced = true
    }

    // 4. 如果没有 CLOUD_CODE_URL 赋值，注入一段
    if (!newJs.includes("env['CLOUD_CODE_URL']")) {
      const anchor = 'const env = { ...process.env'
      const idx = newJs.indexOf(anchor)
      if (idx >= 0) {
        const lineEnd = newJs.indexOf(';', idx)
        if (lineEnd >= 0) {
          const injection = `\n        // Endpoints redirected by BingchaAI\n        env['CLOUD_CODE_URL'] = '${proxyUrl}';\n        env['UNLEASH_URL'] = '${proxyUrl}';`
          newJs = newJs.substring(0, lineEnd + 1) + injection + newJs.substring(lineEnd + 1)
          replaced = true
        }
      }
    }

    // 5. 替换其他本地代理 URL（非我们的端口）
    const localRe = /http:\/\/127\.0\.0\.1:\d+/g
    const otherMatches = newJs.match(localRe)?.filter(m => m !== proxyUrl) || []
    for (const m of otherMatches) {
      newJs = newJs.split(m).join(proxyUrl)
      replaced = true
    }

    if (!replaced) return '未找到可替换的 endpoint，可能 IDE 版本不支持'

    // 备份原始 asar
    if (!fileExists(backupPath)) {
      fs.copyFileSync(asarPath, backupPath)
      _log(`[ide-products] asar backed up: ${backupPath}`)
    }

    // 计算 offset 差异并更新 header
    const newJsBytes = Buffer.from(newJs, 'utf8')
    const sizeDiff = newJsBytes.length - jsOrigSize
    const jsRelOffset = (jsAbsOffset - dataOffset)

    if (sizeDiff !== 0) {
      lsEntry.size = newJsBytes.length
      updateOffsets(header.files, parseInt(lsEntry.offset!, 10), sizeDiff)
    }

    // 重建 asar
    const newAsar = rebuildAsar(asarData, header, newJsBytes, jsRelOffset, jsOrigSize, dataOffset, headerPickleSize)

    // 大小校验
    const diffPercent = ((newAsar.length - asarData.length) / asarData.length) * 100
    if (Math.abs(diffPercent) > 50) {
      _log(`[ide-products] WARNING: asar size change suspicious (${diffPercent.toFixed(1)}%), restoring backup`)
      fs.copyFileSync(backupPath, asarPath)
      return 'asar 大小变化异常，已恢复备份'
    }

    // 原子写入
    const tmpPath = asarPath + '_patch_tmp'
    fs.writeFileSync(tmpPath, newAsar)
    fs.renameSync(tmpPath, asarPath)

    _log(`[ide-products] asar patched (orig=${(asarData.length / 1024).toFixed(0)}KB new=${(newAsar.length / 1024).toFixed(0)}KB)`)
    return ''
  } catch (e: any) {
    _log(`[ide-products] asar patch failed: ${e.message}`)
    return `Patch 失败: ${e.message}`
  }
}

export function restoreAsar(): string {
  const hubPath = detectHubPath()
  if (!hubPath) return 'Hub 未检测到'
  const asarPath = getAsarPath(hubPath)
  const backupPath = asarPath + '.bak'
  if (!fileExists(backupPath)) return '未找到 asar 备份'
  try {
    fs.copyFileSync(backupPath, asarPath)
    fs.unlinkSync(backupPath)
    _log('[ide-products] asar restored from backup')
    return ''
  } catch (e: any) {
    return `恢复失败: ${e.message}`
  }
}

function checkAsarPatched(asarPath: string, proxyUrl: string): boolean {
  try {
    const stat = fs.statSync(asarPath)
    const mtime = stat.mtimeMs
    // Use cache if file hasn't changed
    if (_asarPatchCache && _asarPatchCache.path === asarPath && _asarPatchCache.mtime === mtime) {
      return _asarPatchCache.patched
    }
    const data = fs.readFileSync(asarPath) as Buffer
    const { jsContent } = readAsarJS(data)
    const patched = jsContent.includes(proxyUrl)
    _asarPatchCache = { path: asarPath, mtime, patched }
    return patched
  } catch { return false }
}

// ─── CLI Launch ─────────────────────────────────────────────────────────
export function launchCLI(proxyUrl: string): string {
  const cliPath = detectCLIPath()
  if (!cliPath) return 'CLI 未检测到'
  try {
    const child = spawn(cliPath, [], {
      env: { ...process.env, CLOUD_CODE_URL: proxyUrl },
      detached: true, stdio: 'ignore',
    })
    child.unref()
    _log(`[ide-products] CLI launched with CLOUD_CODE_URL=${proxyUrl} PID=${child.pid}`)
    return ''
  } catch (e: any) {
    return `CLI 启动失败: ${e.message}`
  }
}

// ─── Process Kill & Restart ─────────────────────────────────────────────
export function killAndRestartHub(): void {
  try {
    if (IS_WIN) {
      execFileSync('taskkill', ['/IM', 'Antigravity.exe', '/F'], { stdio: 'ignore', windowsHide: true })
    } else if (IS_MAC) {
      execFileSync('osascript', ['-e', 'tell application "Antigravity" to quit'], { stdio: 'ignore', timeout: 5000 })
    }
  } catch { /* process may not exist */ }

  setTimeout(() => {
    const hubPath = detectHubPath()
    if (!hubPath) return
    try {
      if (IS_WIN) {
        const exePath = path.join(hubPath, 'Antigravity.exe')
        if (fileExists(exePath)) spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref()
      } else if (IS_MAC) {
        spawn('open', ['-a', hubPath], { detached: true, stdio: 'ignore' }).unref()
      }
      _log('[ide-products] Hub restarted')
    } catch (e: any) {
      _log(`[ide-products] Hub restart failed: ${e.message}`)
    }
  }, 3000)
}

// ─── Main API ───────────────────────────────────────────────────────────
export function detectAllProducts(proxyPort: number): IDEStatus {
  const proxyUrl = `http://127.0.0.1:${proxyPort}`
  const products: IDEProduct[] = []

  // 1. Antigravity IDE
  const idePath = detectIDEPath()
  const ideSettingsPath = getIDESettingsPath()
  products.push({
    id: 'antigravity_ide',
    name: 'Antigravity IDE',
    detected: idePath !== '',
    detectedPath: idePath,
    injected: checkSettingsInjected(ideSettingsPath, proxyUrl),
    injectionType: 'settings',
    running: isProcessRunning(['Antigravity IDE.exe', 'Kiro.exe']),
  })

  // 2. Antigravity Hub
  const hubPath = detectHubPath()
  const asarPath = hubPath ? getAsarPath(hubPath) : ''
  products.push({
    id: 'antigravity_hub',
    name: 'Antigravity Hub',
    detected: hubPath !== '',
    detectedPath: hubPath,
    injected: asarPath ? checkAsarPatched(asarPath, proxyUrl) : false,
    injectionType: 'asar',
    running: isProcessRunning(['Antigravity.exe']),
  })

  // 3. CLI
  const cliPath = detectCLIPath()
  products.push({
    id: 'antigravity_cli',
    name: 'Antigravity CLI',
    detected: cliPath !== '',
    detectedPath: cliPath,
    injected: false,
    injectionType: 'env',
    running: false,
  })

  return { products, proxyUrl }
}

export function injectProduct(productId: string, proxyPort: number): string {
  const proxyUrl = `http://127.0.0.1:${proxyPort}`
  switch (productId) {
    case 'antigravity_ide':
      try { injectIDESettings(proxyUrl); return '' } catch (e: any) { return e.message }
    case 'antigravity_hub':
      return patchAsar(proxyPort)
    case 'antigravity_cli':
      return launchCLI(proxyUrl)
    default:
      return `未知产品: ${productId}`
  }
}

export function restoreProduct(productId: string): string {
  switch (productId) {
    case 'antigravity_ide':
      try { restoreIDESettings(); return '' } catch (e: any) { return e.message }
    case 'antigravity_hub':
      return restoreAsar()
    default:
      return `不支持恢复: ${productId}`
  }
}

/** 注入所有已检测到的产品（startRelay 时调用） */
export function injectAllDetected(proxyPort: number): void {
  const status = detectAllProducts(proxyPort)
  for (const p of status.products) {
    if (!p.detected || p.injected) continue
    if (p.injectionType === 'env') continue // CLI 不自动注入
    const err = injectProduct(p.id, proxyPort)
    if (err) _log(`[ide-products] inject ${p.id} failed: ${err}`)
    else _log(`[ide-products] inject ${p.id} ok`)
  }
}
