/**
 * HTTPS 网关
 * 接收 IDE 的 HTTPS 请求，透传给 token-proxy (HTTP :60670)
 */
import * as https from 'https'
import * as http from 'http'
import { CertManager } from './cert-manager'

export interface GatewayOptions {
  /** 网关监听端口 */
  port: number
  /** token-proxy 的 HTTP 地址 */
  proxyTarget: string
  /** 目标域名（证书签发用） */
  domain: string
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

  constructor(options: GatewayOptions) {
    this.options = options
    this.certManager = new CertManager(options.dataDir)
    this.logFn = options.log || console.log
  }

  /** 启动网关 */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._running) { resolve(); return }

      try {
        // 生成证书
        this.certManager.ensureCA()
        const { key, cert } = this.certManager.generateServerCert(this.options.domain)

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
    this.logFn(`[Gateway] [${ts}] #${this.requestCount} ${req.method} ${req.url}`)

    const target = new URL(this.options.proxyTarget)

    const proxyReq = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: target.host,
        },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
        proxyRes.pipe(res)
      }
    )

    proxyReq.on('error', (err) => {
      this.logFn(`[Gateway] 转发失败: ${err.message}`)
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Gateway: token-proxy 连接失败', detail: err.message }))
      }
    })

    // 超时处理
    proxyReq.setTimeout(30000, () => {
      proxyReq.destroy(new Error('Gateway proxy timeout'))
    })

    req.pipe(proxyReq)
  }
}
