/**
 * HTTPS 网关
 * 接收 IDE 的 HTTPS 请求，透传给 token-proxy (HTTP :60670)
 */
import * as https from 'https'
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { CertManager } from './cert-manager'

export interface GatewayOptions {
  /** 网关监听端口 */
  port: number
  /** token-proxy 的 HTTP 地址 */
  proxyTarget: string
  /** 目标域名（证书签发用，支持多域名） */
  domains: string | string[]
  /** 数据目录（证书存储） */
  dataDir: string
  /** 日志函数 */
  log?: (msg: string) => void
}

export class HttpsGateway {
  private server: https.Server | null = null
  private certManager: CertManager
  private options: GatewayOptions
  private requestCount = 0
  private _running = false
  private logFn: (msg: string) => void
  private _dnsOverridePath: string | null = null
  private accessLogPath: string

  constructor(options: GatewayOptions) {
    this.options = options
    this.certManager = new CertManager(options.dataDir)
    this.logFn = options.log || console.log
    this.accessLogPath = path.join(options.dataDir, 'logs', 'https-gateway.log')
  }

  private writeAccessLog(entry: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.accessLogPath), { recursive: true })
      fs.appendFileSync(this.accessLogPath, JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
      }) + '\n', 'utf8')
    } catch {
      // Diagnostics must never break forwarding.
    }
  }

  private summarizeBody(body: Buffer): Record<string, unknown> {
    const summary: Record<string, unknown> = { bodyBytes: body.length }
    if (!body.length) return summary

    const text = body.toString('utf8')
    summary.bodyPrefix = text.slice(0, 300)

    try {
      const payload = JSON.parse(text)
      const model =
        payload.model ||
        payload.modelName ||
        payload.name ||
        payload.request?.model ||
        payload.generationConfig?.model ||
        payload.metadata?.model
      if (model) summary.model = model
      if (Array.isArray(payload.contents)) summary.contentsCount = payload.contents.length
      if (Array.isArray(payload.messages)) summary.messagesCount = payload.messages.length
      if (payload.enabledCreditTypes) summary.enabledCreditTypes = payload.enabledCreditTypes
      if (payload.project || payload.projectId) summary.project = payload.project || payload.projectId
    } catch {
      summary.bodyJson = false
    }

    return summary
  }

  /**
   * 写入 DNS 覆盖脚本，用于注入到 token-proxy 进程
   * 原理：用 dns.resolve4（走 DNS 服务器，绕过 hosts）替代 dns.lookup（受 hosts 影响）
   * TUN 模式下 DNS 返回虚拟 IP，TUN 自动路由到代理
   */
  writeDnsOverride(): string {
    const domains = Array.isArray(this.options.domains) ? this.options.domains : [this.options.domains]
    const domainList = domains.map(d => `  '${d}'`).join(',\n')

    const script = `// Auto-generated DNS override for BCAI Gateway
// 让 token-proxy 绕过 hosts 文件，通过 DNS 服务器解析域名
// hosts 只影响 dns.lookup，不影响 dns.resolve4
const dns = require('dns');
const origLookup = dns.lookup;
const interceptedDomains = new Set([
${domainList}
]);
dns.lookup = function(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (interceptedDomains.has(hostname)) {
    // 用 dns.resolve4 绕过 hosts 文件
    var wantAll = options && options.all;
    return dns.resolve4(hostname, function(err, addresses) {
      if (err || !addresses || addresses.length === 0) {
        // resolve4 失败，回退到原始 lookup
        return origLookup.call(dns, hostname, options, callback);
      }
      if (wantAll) {
        // options.all=true: 返回数组 [{address, family}, ...]
        return callback(null, addresses.map(function(a) { return { address: a, family: 4 }; }));
      }
      // 单结果: callback(err, address, family)
      return callback(null, addresses[0], 4);
    });
  }
  return origLookup.call(dns, hostname, options, callback);
};
`

    const overridePath = path.join(this.options.dataDir, 'dns-override.js')
    fs.writeFileSync(overridePath, script, 'utf8')
    fs.appendFileSync(overridePath, `
;(() => {
  const fixedARecords = {
    'cloudcode-pa.googleapis.com': ['142.251.24.95', '142.250.23.95', '142.250.21.95', '142.251.23.95'],
    'daily-cloudcode-pa.googleapis.com': ['142.250.23.95', '142.251.24.95', '142.251.23.95', '142.250.21.95']
  };
  const previousLookup = dns.lookup;
  function normalizeHost(hostname) {
    return String(hostname || '').replace(/\\.$/, '').toLowerCase();
  }
  dns.lookup = function(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const normalized = normalizeHost(hostname);
    const addresses = fixedARecords[normalized];
    if (addresses && addresses.length > 0) {
      if (options && options.all) {
        return callback(null, addresses.map(function(address) { return { address, family: 4 }; }));
      }
      return callback(null, addresses[Math.floor(Math.random() * addresses.length)], 4);
    }
    return previousLookup.call(dns, hostname, options, callback);
  };
})();
`, 'utf8')
    this._dnsOverridePath = overridePath
    this.logFn(`[Gateway] DNS 覆盖脚本已写入: ${overridePath}`)
    this.logFn(`[Gateway] 拦截域名: ${domains.join(', ')}`)
    return overridePath
  }

  get dnsOverridePath(): string | null { return this._dnsOverridePath }

  /** 启动网关 */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._running) { resolve(); return }

      try {
        // 生成证书
        this.certManager.ensureCA()
        const { key, cert } = this.certManager.generateServerCert(this.options.domains)

        this.server = https.createServer({ key, cert }, (req, res) => {
          this.handleRequest(req, res)
        })

        this.server.on('tlsClientError', (err) => {
          this.logFn(`[Gateway] TLS error: ${(err as Error).message?.substring(0, 80)}`)
        })

        this.server.on('error', (err: any) => {
          this.logFn(`[Gateway] Server error: ${err.message}`)
          if (err.code === 'EADDRINUSE') {
            reject(new Error(`端口 ${this.options.port} 被占用`))
          }
        })

        this.server.listen(this.options.port, '127.0.0.1', () => {
          this._running = true
          this.logFn(`[Gateway] HTTPS 网关启动: https://127.0.0.1:${this.options.port}`)
          this.logFn(`[Gateway] 转发目标: ${this.options.proxyTarget}`)
          resolve()
        })
      } catch (err: any) {
        reject(err)
      }
    })
  }

  /** 停止网关 */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) { this._running = false; resolve(); return }
      this.server.close(() => {
        this._running = false
        this.server = null
        this.logFn('[Gateway] 已停止')
        resolve()
      })
      // 强制超时关闭
      setTimeout(() => {
        if (this.server) {
          this.server.closeAllConnections?.()
          this._running = false
          this.server = null
        }
        resolve()
      }, 3000)
    })
  }

  get running(): boolean { return this._running }
  get totalRequests(): number { return this.requestCount }
  get certMgr(): CertManager { return this.certManager }

  /** 转发请求到 token-proxy */
  private handleRequest(req: https.IncomingMessage, res: http.ServerResponse): void {
    this.requestCount++
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    const reqId = this.requestCount
    const startedAt = Date.now()
    const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
    const sni = (req.socket as any)?.servername || ''
    const authState = req.headers.authorization ? 'present' : 'missing'
    this.logFn(`[Gateway] [${ts}] #${reqId} host=${host || '-'} sni=${sni || '-'} ${req.method} ${req.url}`)

    const target = new URL(this.options.proxyTarget)
    const isGenerate =
      req.url?.includes('streamGenerateContent') ||
      req.url?.includes(':generateContent') ||
      req.url?.includes('generateContent') ||
      false

    // 缓冲请求体
    const bodyChunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => bodyChunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(bodyChunks)
      this.writeAccessLog({
        reqId,
        phase: 'inbound',
        host,
        sni,
        method: req.method,
        url: req.url,
        auth: authState,
        contentType: req.headers['content-type'] || '',
        userAgent: req.headers['user-agent'] || '',
        isGenerate,
        ...this.summarizeBody(body),
      })

      const proxyReq = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            'content-length': String(body.length),
          },
        },
        (proxyRes) => {
          this.writeAccessLog({
            reqId,
            phase: 'response',
            host,
            method: req.method,
            url: req.url,
            statusCode: proxyRes.statusCode || 0,
            durationMs: Date.now() - startedAt,
            target: this.options.proxyTarget,
          })
          // 捕获非200响应体用于调试
          if (proxyRes.statusCode && proxyRes.statusCode >= 400) {
            const errChunks: Buffer[] = []
            proxyRes.on('data', (ch: Buffer) => errChunks.push(ch))
            proxyRes.on('end', () => {
              const errBody = Buffer.concat(errChunks)
              const snippet = errBody.toString('utf8').substring(0, 500)
              this.logFn(`[Gateway] error response (${proxyRes.statusCode}): ${snippet}`)
              this.writeAccessLog({ reqId, phase: 'error-body', statusCode: proxyRes.statusCode, body: snippet })
              res.writeHead(proxyRes.statusCode, proxyRes.headers)
              res.end(errBody)
            })
          } else {
            res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
            proxyRes.pipe(res)
          }
        }
      )

      proxyReq.on('error', (err) => {
        this.logFn(`[Gateway] 转发失败: ${err.message}`)
        this.writeAccessLog({
          reqId,
          phase: 'proxy-error',
          host,
          method: req.method,
          url: req.url,
          error: err.message,
          durationMs: Date.now() - startedAt,
        })
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Gateway: token-proxy 连接失败', detail: err.message }))
        }
      })

      // 超时处理
      proxyReq.setTimeout(30000, () => {
        proxyReq.destroy(new Error('Gateway proxy timeout'))
      })

      // 为 streamGenerateContent 请求注入积分参数
      if (isGenerate) {
        try {
          const text = body.toString('utf8')
          const payload = JSON.parse(text)
          const credits = Array.isArray(payload.enabledCreditTypes) ? payload.enabledCreditTypes : []
          const needsInject = !credits.includes('GOOGLE_ONE_AI') && !credits.includes(1)
          if (needsInject) {
            // 只在需要注入时才重新序列化
            payload.enabledCreditTypes = [...credits, 'GOOGLE_ONE_AI']
            const modifiedBody = Buffer.from(JSON.stringify(payload))
            proxyReq.setHeader('content-length', String(modifiedBody.length))
            proxyReq.write(modifiedBody)
          } else {
            // 已包含，直接透传原始 body
            proxyReq.write(body)
          }
        } catch (e) {
          proxyReq.write(body)
        }
      } else {
        proxyReq.write(body)
      }
      proxyReq.end()
    })
  }
}
