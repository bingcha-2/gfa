/**
 * Hosts 文件 + 端口转发管理器
 * 管理 Windows hosts 文件条目和 netsh portproxy 规则
 */
import * as fs from 'fs'
import { execFileSync } from 'child_process'

const HOSTS_PATH = 'C:\\Windows\\System32\\drivers\\etc\\hosts'
const MARKER = '# BCAI-Gateway'

export class HostsManager {
  private log: (msg: string) => void

  constructor(log?: (msg: string) => void) {
    this.log = log || console.log
  }

  /** 添加 hosts 条目 + netsh 端口转发（支持多域名） */
  enableIntercept(domains: string | string[], gatewayPort: number): boolean {
    const domainList = Array.isArray(domains) ? domains : [domains]
    try {
      // 1. 添加所有域名的 hosts 条目
      for (const domain of domainList) {
        this.addHostsEntry(domain)
      }

      // 2. 设置端口转发 443 → gatewayPort
      this.addPortProxy(443, gatewayPort)

      this.log(`[Hosts] 拦截已启用: ${domainList.join(', ')} → 127.0.0.1:${gatewayPort}`)
      return true
    } catch (err: any) {
      this.log(`[Hosts] 启用拦截失败: ${err.message}`)
      return false
    }
  }

  /** 移除 hosts 条目 + netsh 端口转发（支持多域名） */
  disableIntercept(domains: string | string[]): boolean {
    const domainList = Array.isArray(domains) ? domains : [domains]
    try {
      for (const domain of domainList) {
        this.removeHostsEntry(domain)
      }
      this.removePortProxy(443)
      this.log(`[Hosts] 拦截已禁用`)
      return true
    } catch (err: any) {
      this.log(`[Hosts] 禁用拦截失败: ${err.message}`)
      return false
    }
  }

  /** 检查是否正在拦截（任一域名匹配即返回 true） */
  isIntercepting(domains: string | string[]): boolean {
    const domainList = Array.isArray(domains) ? domains : [domains]
    try {
      const content = fs.readFileSync(HOSTS_PATH, 'utf8')
      if (!content.includes(MARKER)) return false
      return domainList.some(d => content.includes(d))
    } catch {
      return false
    }
  }

  /** 启动时清理残留（防止上次异常退出） */
  cleanupStale(): void {
    try {
      const content = fs.readFileSync(HOSTS_PATH, 'utf8')
      if (content.includes(MARKER)) {
        this.log('[Hosts] 发现残留条目，正在清理...')
        const cleaned = content
          .split(/\r?\n/)
          .filter(line => !line.includes(MARKER))
          .join('\n')
        fs.writeFileSync(HOSTS_PATH, cleaned, 'utf8')

        // 同时清理端口转发
        try {
          execFileSync('netsh', [
            'interface', 'portproxy', 'delete', 'v4tov4',
            'listenport=443', 'listenaddress=127.0.0.1'
          ], { windowsHide: true, stdio: 'pipe' })
        } catch { /* 可能不存在 */ }

        this.log('[Hosts] 残留已清理')
      }
    } catch (err: any) {
      this.log(`[Hosts] 清理残留失败: ${err.message}`)
    }
  }

  // ─── 私有方法 ───

  private addHostsEntry(domain: string): void {
    const content = fs.readFileSync(HOSTS_PATH, 'utf8')
    // 检查该域名是否已存在（而不是只检查 MARKER）
    if (content.includes(`${domain}  ${MARKER}`)) return

    // 同时写入 IPv4 和 IPv6，防止系统优先走 IPv6 绕过劫持
    const entry = `\n127.0.0.1  ${domain}  ${MARKER}\n::1  ${domain}  ${MARKER}\n`
    fs.appendFileSync(HOSTS_PATH, entry, 'utf8')
  }

  private removeHostsEntry(_domain: string): void {
    const content = fs.readFileSync(HOSTS_PATH, 'utf8')
    const cleaned = content
      .split(/\r?\n/)
      .filter(line => !line.includes(MARKER))
      .join('\n')
    fs.writeFileSync(HOSTS_PATH, cleaned, 'utf8')
  }

  private addPortProxy(listenPort: number, connectPort: number): void {
    // 先尝试删除旧的
    try {
      execFileSync('netsh', [
        'interface', 'portproxy', 'delete', 'v4tov4',
        `listenport=${listenPort}`, 'listenaddress=127.0.0.1'
      ], { windowsHide: true, stdio: 'pipe' })
    } catch { /* 可能不存在 */ }

    execFileSync('netsh', [
      'interface', 'portproxy', 'add', 'v4tov4',
      `listenport=${listenPort}`, 'listenaddress=127.0.0.1',
      `connectport=${connectPort}`, 'connectaddress=127.0.0.1'
    ], { windowsHide: true, stdio: 'pipe' })
  }

  private removePortProxy(listenPort: number): void {
    try {
      execFileSync('netsh', [
        'interface', 'portproxy', 'delete', 'v4tov4',
        `listenport=${listenPort}`, 'listenaddress=127.0.0.1'
      ], { windowsHide: true, stdio: 'pipe' })
    } catch { /* 可能不存在 */ }
  }
}
