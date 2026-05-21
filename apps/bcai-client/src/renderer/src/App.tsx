import { useState, useEffect, useCallback } from 'react'

// 声明 electron preload 暴露的 API
declare global {
  interface Window {
    electronAPI?: {
      send: (type: string, payload?: any) => void
      onStateUpdate: (callback: (state: any) => void) => () => void
      onNotification: (callback: (msg: string) => void) => () => void
    }
  }
}

function sendAction(type: string, payload?: any) {
  window.electronAPI?.send(type, payload)
}

export default function App() {
  const [state, setState] = useState<any>(null)
  const [keyInput, setKeyInput] = useState('')
  const [showKeyModal, setShowKeyModal] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const unsub = window.electronAPI?.onStateUpdate((newState) => {
      setState(newState)
      setLoading(false)
    })
    // 请求初始状态
    sendAction('rosetta:getState')
    return unsub
  }, [])

  const relay = state?.relay || {}
  const ide = state?.ide || {}
  const proxy = state?.proxy || {}
  const serviceStatus = relay.serviceStatus || {}
  const accessKey = relay.accessKeyStatus
  const portConflict = state?.portConflict
  const hasKey = relay.hasApiKey
  const isRunning = relay.running
  const gw = state?.gateway || {}

  const handleToggleRelay = useCallback(() => {
    setLoading(true)
    sendAction('rosetta:toggleRelay')
  }, [])

  const handleToggleGateway = useCallback(() => {
    setLoading(true)
    sendAction(gw.enabled ? 'gateway:disable' : 'gateway:enable')
  }, [gw.enabled])

  const handleSetKey = useCallback(() => {
    if (!keyInput.trim()) return
    sendAction('rosetta:setRelayKey', { secret: keyInput.trim() })
    setShowKeyModal(false)
    setKeyInput('')
  }, [keyInput])

  // 状态指示灯颜色
  const statusTone = serviceStatus.tone || (state ? 'muted' : 'muted')
  const toneColor: string = ({
    good: '#22c55e',
    warning: '#f59e0b',
    bad: '#ef4444',
    muted: '#6b7280',
  } as Record<string, string>)[statusTone] || '#6b7280'

  // 未加载完成时显示加载中
  if (!state) {
    return (
      <div className="app-root">
        <header className="app-header">
          <h1>🍵 冰茶AI</h1>
        </header>
        <div className="status-card" style={{ textAlign: 'center', padding: '40px 20px' }}>
          <div className="status-dot" style={{ background: '#6b7280', margin: '0 auto 12px' }} />
          <p style={{ color: 'var(--text-muted)' }}>正在连接...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="app-root">
      <header className="app-header">
        <h1>🍵 冰茶AI</h1>
        <span className="app-version">v{state?.config?.relayProxy?.clientVersion || '4.1.0'}</span>
      </header>

      {/* 端口冲突警告 */}
      {portConflict && (
        <div className="alert alert-danger">
          <strong>⚠️ 端口冲突</strong>
          <p>端口 {portConflict.port} 已被占用（可能是 IDE 插件正在运行）。</p>
          <p>请先在 IDE 侧边栏关闭续杯/一键接管，再使用客户端。</p>
        </div>
      )}

      {/* 网络检测警告 */}
      {proxy.outbound?.tested && !proxy.outbound?.success && (
        <div className="alert alert-danger">
          <strong>⚠️ 网络受限</strong>
          <p>Node 转发引擎无法访问 Google，您的代理软件没有接管底层流量。</p>
          <p><strong>解决办法：</strong>开启代理软件的 TUN/虚拟网卡模式。</p>
        </div>
      )}

      {/* 首次使用引导 — 没有卡密且没有运行 */}
      {!hasKey && !isRunning && (
        <div className="onboarding">
          <div className="onboarding-icon">🔑</div>
          <h2>欢迎使用冰茶AI</h2>
          <p>请先设置您的续杯卡密，然后一键开启续杯服务。</p>
          <button
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 16 }}
            onClick={() => { setKeyInput(''); setShowKeyModal(true) }}
          >
            设置卡密
          </button>
        </div>
      )}

      {/* 续杯状态卡片 — 有卡密或正在运行时显示 */}
      {(hasKey || isRunning) && (
        <div className="status-card">
          <div className="status-header">
            <div className="status-dot" style={{ background: toneColor }} />
            <span className="status-label">{serviceStatus.label || '就绪'}</span>
          </div>
          {serviceStatus.detail && (
            <p className="status-detail">{serviceStatus.detail}</p>
          )}

          {/* 卡密信息 */}
          {accessKey && (
            <div className="key-info">
              <div className="key-row">
                <span>卡密名称</span>
                <strong>{accessKey.name || accessKey.id || '—'}</strong>
              </div>
              {accessKey.expiresAt && (
                <div className="key-row">
                  <span>到期时间</span>
                  <strong>{new Date(accessKey.expiresAt).toLocaleString('zh-CN')}</strong>
                </div>
              )}

              {/* 5 小时恢复时间 */}
              {(accessKey.tokenWindowResetAt || accessKey.tokenWindowResetMs > 0) && (
                <div className="key-row">
                  <span>额度恢复</span>
                  <strong className="reset-time">{formatResetTime(accessKey.tokenWindowResetAt, accessKey.tokenWindowResetMs)}</strong>
                </div>
              )}

              {/* Opus 额度 */}
              {accessKey.opusTokensUsed != null && (
                <div className="key-row">
                  <span>Opus 用量</span>
                  <strong>{formatTokens(accessKey.opusTokensUsed)} / {formatTokens(accessKey.opusTokenLimit)}</strong>
                </div>
              )}
              {accessKey.opusTokensUsed != null && accessKey.opusTokenLimit != null && (
                <div className="quota-bar-wrap">
                  <div
                    className="quota-bar"
                    style={{
                      width: `${Math.min(100, (accessKey.opusTokensUsed / (accessKey.opusTokenLimit || 1)) * 100)}%`,
                      background: accessKey.opusTokensUsed >= accessKey.opusTokenLimit ? '#ef4444' : '#6366f1',
                    }}
                  />
                </div>
              )}

              {/* Gemini 额度 */}
              {accessKey.geminiTokensUsed != null && (
                <div className="key-row">
                  <span>Gemini 用量</span>
                  <strong>{formatTokens(accessKey.geminiTokensUsed)} / {formatTokens(accessKey.geminiTokenLimit)}</strong>
                </div>
              )}
              {accessKey.geminiTokensUsed != null && accessKey.geminiTokenLimit != null && (
                <div className="quota-bar-wrap">
                  <div
                    className="quota-bar"
                    style={{
                      width: `${Math.min(100, (accessKey.geminiTokensUsed / (accessKey.geminiTokenLimit || 1)) * 100)}%`,
                      background: accessKey.geminiTokensUsed >= accessKey.geminiTokenLimit ? '#ef4444' : '#22c55e',
                    }}
                  />
                </div>
              )}

              {/* 总 Token 窗口 */}
              {accessKey.tokenWindowRemaining != null && accessKey.tokenWindowLimit != null && (
                <div className="key-row">
                  <span>窗口剩余</span>
                  <strong>{formatTokens(accessKey.tokenWindowRemaining)} / {formatTokens(accessKey.tokenWindowLimit)}</strong>
                </div>
              )}
            </div>
          )}

          {/* 请求统计 */}
          {isRunning && (
            <div className="stats-row">
              <span>请求: {relay.totalRequests || 0}</span>
              <span>错误: {relay.totalErrors || 0}</span>
              <span>入: {formatTokens(relay.totalInputTokens)}</span>
              <span>出: {formatTokens(relay.totalOutputTokens)}</span>
            </div>
          )}
        </div>
      )}

      {/* IDE 状态 */}
      {(hasKey || isRunning) && (
        <div className="ide-status">
          <span className={`ide-dot ${ide.isConfigured ? 'connected' : ''}`} />
          <span>IDE {ide.isConfigured ? '已接入' : '未接入'}</span>
          {gw.enabled && <span className="ide-url">网关模式</span>}
          {!gw.enabled && ide.isConfigured && ide.configuredUrl && <span className="ide-url">{ide.configuredUrl}</span>}
          {!gw.enabled && !ide.isConfigured && isRunning && <span className="ide-url" style={{ color: 'var(--warning)' }}>开启后自动接入</span>}
        </div>
      )}

      {/* 网关模式 */}
      {(hasKey || isRunning) && (
        <div className="status-card" style={{ marginTop: 8 }}>
          <div className="status-header">
            <div className="status-dot" style={{ background: gw.running ? '#22c55e' : '#6b7280' }} />
            <span className="status-label">HTTPS 网关</span>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
              {gw.enabled ? (gw.running ? '运行中' : '启动中...') : '未启用'}
            </span>
          </div>
          {gw.enabled && (
            <div className="key-info" style={{ marginTop: 8 }}>
              <div className="key-row">
                <span>拦截域名</span>
                <strong style={{ fontSize: 11 }}>{gw.domain}</strong>
              </div>
              <div className="key-row">
                <span>CA 证书</span>
                <strong style={{ color: gw.caInstalled ? '#22c55e' : '#ef4444' }}>
                  {gw.caInstalled ? '✅ 已安装' : '❌ 未安装'}
                </strong>
              </div>
              <div className="key-row">
                <span>Hosts 劫持</span>
                <strong style={{ color: gw.hostsActive ? '#22c55e' : '#ef4444' }}>
                  {gw.hostsActive ? '✅ 已启用' : '❌ 未启用'}
                </strong>
              </div>
              {gw.totalRequests > 0 && (
                <div className="key-row">
                  <span>网关请求</span>
                  <strong>{gw.totalRequests}</strong>
                </div>
              )}
            </div>
          )}
          <button
            className={`btn ${gw.enabled ? 'btn-danger' : 'btn-secondary'}`}
            style={{ width: '100%', marginTop: 10, fontSize: 13 }}
            onClick={handleToggleGateway}
            disabled={loading}
          >
            {loading ? '⏳ 处理中...' : gw.enabled ? '🔓 关闭网关' : '🔒 启用 HTTPS 网关'}
          </button>
          {!gw.enabled && (
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>
              启用后 IDE 无需修改任何配置，流量自动通过本地网关转发。
              需要管理员权限（首次安装证书 + 修改 hosts）。
            </p>
          )}
        </div>
      )}

      {/* 操作按钮 — 有卡密时显示 */}
      {(hasKey || isRunning) && (
        <div className="actions">
          <button
            className="btn btn-secondary"
            onClick={() => { setKeyInput(''); setShowKeyModal(true) }}
          >
            ⚙️ 设置卡密
          </button>
          <button
            className={`btn ${isRunning ? 'btn-danger' : 'btn-primary'}`}
            onClick={handleToggleRelay}
            disabled={loading || Boolean(portConflict)}
          >
            {loading ? '⏳ 处理中...' : isRunning ? '⏹ 停止续杯' : '▶ 开启续杯'}
          </button>
        </div>
      )}

      {/* 卡密输入弹窗 */}
      {showKeyModal && (
        <div className="modal-overlay" onClick={() => setShowKeyModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>设置续杯卡密</h3>
            <input
              type="password"
              className="input"
              placeholder="输入您的卡密..."
              value={keyInput}
              onChange={e => setKeyInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSetKey()}
              autoFocus
            />
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowKeyModal(false)}>取消</button>
              <button className="btn btn-primary" onClick={handleSetKey} disabled={!keyInput.trim()}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function formatTokens(n: number | undefined | null): string {
  if (n == null || !n) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

function formatResetTime(resetAt: string | undefined, resetMs: number | undefined): string {
  // 优先用 resetMs 倒计时
  if (resetMs != null && resetMs > 0) {
    const hours = Math.floor(resetMs / 3600000)
    const minutes = Math.floor((resetMs % 3600000) / 60000)
    if (hours > 0) return `${hours}小时${minutes}分钟后恢复`
    return `${minutes}分钟后恢复`
  }
  // 用 resetAt 时间戳
  if (resetAt) {
    const resetDate = new Date(resetAt)
    const now = new Date()
    const diffMs = resetDate.getTime() - now.getTime()
    if (diffMs > 0) {
      const hours = Math.floor(diffMs / 3600000)
      const minutes = Math.floor((diffMs % 3600000) / 60000)
      if (hours > 0) return `${hours}小时${minutes}分钟后恢复`
      return `${minutes}分钟后恢复`
    }
    return '已恢复'
  }
  return '—'
}
