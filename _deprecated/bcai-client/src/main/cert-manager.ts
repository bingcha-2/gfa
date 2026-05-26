/**
 * 证书管理器
 * 生成 CA 根证书 + 域名服务器证书，管理系统信任存储
 */
import * as forge from 'node-forge'
import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'

const CA_CN = 'BCAI Local CA'
const CA_ORG = 'BCAI'

export interface CertPair {
  key: string   // PEM private key
  cert: string  // PEM certificate
}

export class CertManager {
  private certsDir: string
  private caKeyPath: string
  private caCertPath: string
  private caKey: forge.pki.rsa.PrivateKey | null = null
  private caCert: forge.pki.Certificate | null = null

  constructor(dataDir: string) {
    this.certsDir = path.join(dataDir, 'certs')
    this.caKeyPath = path.join(this.certsDir, 'bcai-ca.key')
    this.caCertPath = path.join(this.certsDir, 'bcai-ca.crt')
    fs.mkdirSync(this.certsDir, { recursive: true })
  }

  /** 确保 CA 根证书存在，不存在则生成 */
  ensureCA(): void {
    if (this.caKey && this.caCert) return

    if (fs.existsSync(this.caKeyPath) && fs.existsSync(this.caCertPath)) {
      // 从磁盘加载
      this.caKey = forge.pki.privateKeyFromPem(fs.readFileSync(this.caKeyPath, 'utf8'))
      this.caCert = forge.pki.certificateFromPem(fs.readFileSync(this.caCertPath, 'utf8'))
      return
    }

    // 生成新的 CA
    const keys = forge.pki.rsa.generateKeyPair(2048)
    const cert = forge.pki.createCertificate()
    cert.publicKey = keys.publicKey
    cert.serialNumber = '01'
    cert.validity.notBefore = new Date()
    cert.validity.notAfter = new Date()
    cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 10)

    const attrs = [
      { name: 'commonName', value: CA_CN },
      { name: 'organizationName', value: CA_ORG },
    ]
    cert.setSubject(attrs)
    cert.setIssuer(attrs)
    cert.setExtensions([
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true },
    ])
    cert.sign(keys.privateKey, forge.md.sha256.create())

    fs.writeFileSync(this.caKeyPath, forge.pki.privateKeyToPem(keys.privateKey))
    fs.writeFileSync(this.caCertPath, forge.pki.certificateToPem(cert))

    this.caKey = keys.privateKey
    this.caCert = cert
  }

  /** 用 CA 为指定域名签发服务器证书（支持多域名） */
  generateServerCert(domains: string | string[]): CertPair {
    this.ensureCA()
    if (!this.caKey || !this.caCert) throw new Error('CA not initialized')

    const domainList = Array.isArray(domains) ? domains : [domains]
    const primaryDomain = domainList[0]

    const keys = forge.pki.rsa.generateKeyPair(2048)
    const cert = forge.pki.createCertificate()
    cert.publicKey = keys.publicKey
    cert.serialNumber = String(Date.now())
    cert.validity.notBefore = new Date()
    cert.validity.notAfter = new Date()
    cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 1)

    cert.setSubject([{ name: 'commonName', value: primaryDomain }])
    cert.setIssuer(this.caCert.subject.attributes)

    // 为所有域名生成 SAN 条目
    const altNames: any[] = domainList.map(d => ({ type: 2, value: d }))
    altNames.push({ type: 2, value: 'localhost' })
    altNames.push({ type: 7, ip: '127.0.0.1' })

    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ])
    cert.sign(this.caKey, forge.md.sha256.create())

    return {
      key: forge.pki.privateKeyToPem(keys.privateKey),
      cert: forge.pki.certificateToPem(cert),
    }
  }

  /** 安装 CA 到 Windows 系统信任存储 */
  installCATrust(): boolean {
    try {
      this.ensureCA()
      execFileSync('certutil', ['-addstore', 'Root', this.caCertPath], {
        windowsHide: true,
        stdio: 'pipe',
      })
      return true
    } catch (err: any) {
      console.error(`[CertManager] install CA failed: ${err.message}`)
      return false
    }
  }

  /** 从 Windows 信任存储中删除 CA */
  uninstallCATrust(): boolean {
    try {
      execFileSync('certutil', ['-delstore', 'Root', CA_CN], {
        windowsHide: true,
        stdio: 'pipe',
      })
      return true
    } catch {
      return false
    }
  }

  /** 检查 CA 是否已安装到信任存储 */
  isCATrusted(): boolean {
    try {
      const output = execFileSync('certutil', ['-store', 'Root', CA_CN], {
        windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return output.includes(CA_CN)
    } catch {
      return false
    }
  }

  /** 获取 CA 证书文件路径 */
  getCACertPath(): string {
    return this.caCertPath
  }
}
