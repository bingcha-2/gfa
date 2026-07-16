import { useCallback, useEffect, useState } from 'react'
import {
  Settings2, FolderSearch, ScanSearch, FileCog, Gauge, ArrowRight, Loader2,
  Palette, Copy, FolderOpen, RefreshCw,
} from 'lucide-react'
import {
  type CodexSettings, type CodexSkinChannelStatus,
  getCodexSettings, saveCodexSettings,
  getCodexQuickConfig, saveCodexQuickConfig,
  browseForPath, detectCodexAppPath, openCodexConfigToml,
  getCodexSkinChannel, setCodexSkinChannel, restartCodexForSkinChannel, openCodexSkinSkillFolder,
} from '@/services/localApi'
import type { PageId } from '@/types'
import { cn } from '@/lib/utils'

/**
 * Codex 设置 tab(codex-only)——「Codex 设置」面板。
 *
 * 涵盖:显示 API 服务入口 / 筛选记忆 / 显示 Code Review 配额 / 切换时自动启动 Codex App /
 * 切换时重启指定应用 三组开关;Codex app 路径(输入 + 选择 + 检测);打开 config.toml;
 * 配额自动刷新间隔(只读跳转到「保活」,不在此重复设置);上下文与压缩阈值预设
 * (默认 / 516K / 1M / 自定义 + 两个数字输入)。
 *
 * 明确不做:OpenClaw / OpenCode 凭证覆盖开关。
 * 红线:只读写本地 Codex 设置与 ~/.codex/config.toml,与远程租号 / 网关出口无关。
 * 视觉沿用 GFA token(琥珀单色、克制分区、对比 ≥4.5:1),所有可点元素 cursor-pointer。
 */

/** 上下文窗口/压缩阈值内置预设(口径对齐 cockpit CodexQuickConfigCard)。 */
const CONTEXT_PRESETS = {
  preset_516k: { contextWindow: 516000, autoCompact: 460000 },
  preset_1m: { contextWindow: 1000000, autoCompact: 900000 },
} as const

type PresetId = 'default' | 'preset_516k' | 'preset_1m' | 'custom'

/** 据回读的 detected 值反推当前命中的预设;两个键都缺 = 默认,否则按值匹配,失配 = 自定义。 */
function resolvePreset(mcw?: number, ac?: number): PresetId {
  if (!mcw && !ac) return 'default'
  if (mcw === CONTEXT_PRESETS.preset_516k.contextWindow && ac === CONTEXT_PRESETS.preset_516k.autoCompact) return 'preset_516k'
  if (mcw === CONTEXT_PRESETS.preset_1m.contextWindow && ac === CONTEXT_PRESETS.preset_1m.autoCompact) return 'preset_1m'
  return 'custom'
}

const PRESET_OPTIONS: [PresetId, string, string][] = [
  ['default', '默认', '移除两个字段,回到官方默认'],
  ['preset_516k', '516K', 'context=516000 / compact=460000'],
  ['preset_1m', '1M', 'context=1000000 / compact=900000'],
  ['custom', '自定义', '手动填写上下文与压缩阈值'],
]

function Switch({ label, desc, checked, onToggle, busy }: {
  label: string; desc: string; checked: boolean; onToggle: () => void; busy: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className="text-[13px] font-semibold text-[var(--text-primary)]">{label}</div>
        <div className="text-[11px] text-[var(--text-muted)] mt-0.5">{desc}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={busy}
        onClick={onToggle}
        className={cn(
          'cursor-pointer w-[42px] h-[24px] rounded-full relative transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed',
          checked ? 'bg-[var(--primary)]' : 'bg-[var(--switch-off)]',
        )}
      >
        <span className={cn('absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white transition-all', checked ? 'right-[3px]' : 'left-[3px]')} />
      </button>
    </div>
  )
}

/** 'wakeup' = 切到 suite 内「保活」tab(自动刷新间隔在那里统一设置);其余为全局页。 */
export type SettingsNavTarget = PageId | 'wakeup'

export function LocalSettingsTab({ onNavigate }: { onNavigate?: (p: SettingsNavTarget) => void }) {
  const [settings, setSettings] = useState<CodexSettings | null>(null)
  const [pathDraft, setPathDraft] = useState('')
  const [preset, setPreset] = useState<PresetId>('default')
  const [customCtx, setCustomCtx] = useState('')
  const [customCompact, setCustomCompact] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [skin, setSkin] = useState<CodexSkinChannelStatus | null>(null)
  const [skinCopied, setSkinCopied] = useState(false)

  const load = useCallback(async () => {
    try {
      // 皮肤通道状态失败时优雅降级(卡片不渲染),不拖垮其余设置项。
      const [s, q, sk] = await Promise.all([
        getCodexSettings(),
        getCodexQuickConfig(),
        getCodexSkinChannel().catch(() => null),
      ])
      setSettings(s)
      setSkin(sk)
      setPathDraft(s.codexAppPath)
      const p = resolvePreset(q.detectedModelContextWindow, q.detectedAutoCompactTokenLimit)
      setPreset(p)
      setCustomCtx(q.detectedModelContextWindow ? String(q.detectedModelContextWindow) : '')
      setCustomCompact(q.detectedAutoCompactTokenLimit ? String(q.detectedAutoCompactTokenLimit) : '')
      setErr('')
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // 皮肤通道:开关与实际状态不一致(等重启/待关闭)时轮询探测 —— Codex 冷启动可能比
  // 重启按钮的等待窗口慢,起来后状态自动翻转,不需要用户重进页面。
  // 封顶 ~60s(20 次):若用户迟迟不重启,状态不会收敛,不能无限每 3s 打后端。
  useEffect(() => {
    if (!skin || skin.enabled === skin.live) return
    let attempts = 0
    const timer = setInterval(() => {
      if (++attempts > 20) { clearInterval(timer); return }
      getCodexSkinChannel().then(setSkin).catch(() => { /* 探测失败保持现状 */ })
    }, 3000)
    return () => clearInterval(timer)
  }, [skin?.enabled, skin?.live]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 合并补丁后落盘,回填以反映 clamp。 */
  const patch = async (next: Partial<CodexSettings>) => {
    if (!settings) return
    setBusy('settings')
    try {
      const applied = await saveCodexSettings({ ...settings, ...next })
      setSettings(applied)
      setPathDraft(applied.codexAppPath)
      setErr('')
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onBrowse = async () => {
    setBusy('browse')
    try {
      const picked = await browseForPath('选择 Codex App')
      if (picked) await patch({ codexAppPath: picked })
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onDetect = async () => {
    setBusy('detect')
    try {
      const found = await detectCodexAppPath()
      if (found) await patch({ codexAppPath: found })
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onOpenConfig = async () => {
    setBusy('config')
    try {
      await openCodexConfigToml()
      setErr('')
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  /** 落盘 quick config 两个键(null=删键),回读回填。 */
  const writeQuick = async (mcw: number | null, ac: number | null) => {
    setBusy('quick')
    try {
      await saveCodexQuickConfig(mcw, ac)
      setErr('')
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onPickPreset = (id: PresetId) => {
    setPreset(id)
    if (id === 'custom') return
    if (id === 'default') { void writeQuick(null, null); return }
    const p = CONTEXT_PRESETS[id]
    setCustomCtx(String(p.contextWindow))
    setCustomCompact(String(p.autoCompact))
    void writeQuick(p.contextWindow, p.autoCompact)
  }

  const onSaveCustom = () => {
    const mcw = Number(customCtx) || 0
    const ac = Number(customCompact) || 0
    void writeQuick(mcw > 0 ? mcw : null, ac > 0 ? ac : null)
  }

  /** 皮肤通道:开关只改「下次启动」行为;重启由用户显式点按钮。 */
  const onToggleSkin = async () => {
    if (!skin) return
    setBusy('skin')
    try {
      setSkin(await setCodexSkinChannel(!skin.enabled))
      setErr('')
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onSkinRestart = async () => {
    setBusy('skinRestart')
    try {
      setSkin(await restartCodexForSkinChannel())
      setErr('')
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onCopySkillDir = async () => {
    if (!skin) return
    try {
      await navigator.clipboard.writeText(skin.skillDir)
      setSkinCopied(true)
      setTimeout(() => setSkinCopied(false), 2000)
    } catch {
      /* clipboard 不可用时静默 */
    }
  }

  const onOpenSkillFolder = async () => {
    setBusy('skinOpen')
    try {
      await openCodexSkinSkillFolder()
      setErr('')
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <div className="px-4 py-10 text-center text-[12px] text-[var(--text-muted)]">加载中…</div>

  const s = settings
  const spin = (key: string) => busy === key

  return (
    <div className="flex flex-col gap-4">
      {err && <div className="rounded-[8px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2 text-[12px] text-[var(--danger)] break-all">{err}</div>}

      {/* 开关组:入口/记忆/配额/启动/重启 */}
      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4 flex flex-col gap-3.5">
        <div className="text-[13px] font-semibold text-[var(--text-primary)] inline-flex items-center gap-1.5"><Settings2 size={14} /> Codex 设置</div>
        {s && (
          <div className="flex flex-col gap-3.5 divide-y divide-[var(--border-light)] [&>*:not(:first-child)]:pt-3.5">
            <Switch label="显示 API 服务入口" desc="仅控制 Codex 总览中的 API 服务入口显示,不会停止本地 API 服务。" checked={s.showApiEntry} busy={spin('settings')} onToggle={() => void patch({ showApiEntry: !s.showApiEntry })} />
            <Switch label="筛选记忆" desc="记住上次的账号筛选条件,重开页面后自动恢复。" checked={s.filterMemory} busy={spin('settings')} onToggle={() => void patch({ filterMemory: !s.filterMemory })} />
            <Switch label="显示 Code Review 配额" desc="在配额展示中额外显示 Code Review 用量。" checked={s.showCodeReviewQuota} busy={spin('settings')} onToggle={() => void patch({ showCodeReviewQuota: !s.showCodeReviewQuota })} />
            <Switch label="切换时自动启动 Codex App" desc="切换账号后自动启动(或重启)Codex App。" checked={s.launchOnSwitch} busy={spin('settings')} onToggle={() => void patch({ launchOnSwitch: !s.launchOnSwitch })} />
            <Switch label="切换时重启指定应用" desc="开启后按下方路径重启指定应用(适用于依赖插件宿主的场景)。" checked={s.restartAppOnSwitch} busy={spin('settings')} onToggle={() => void patch({ restartAppOnSwitch: !s.restartAppOnSwitch })} />
          </div>
        )}
      </div>

      {/* Codex app 路径 + 打开 config.toml */}
      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4 flex flex-col gap-3">
        <div className="text-[11px] font-bold text-[var(--text-muted)] tracking-wide">Codex App 路径</div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            aria-label="Codex app 路径"
            value={pathDraft}
            placeholder="默认路径(留空)"
            disabled={!!busy}
            onChange={(e) => setPathDraft(e.target.value)}
            onBlur={() => { if (s && pathDraft !== s.codexAppPath) void patch({ codexAppPath: pathDraft }) }}
            className="flex-1 min-w-0 rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-3 h-[34px] text-[12px] font-mono-data text-[var(--text-primary)] outline-none focus:border-[var(--primary)] disabled:opacity-50"
          />
          <button
            type="button"
            aria-label="选择 Codex app 路径"
            disabled={!!busy}
            onClick={() => void onBrowse()}
            className="cursor-pointer text-[12px] font-semibold px-2.5 h-[34px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {spin('browse') ? <Loader2 size={13} className="animate-spin" /> : <FolderSearch size={13} />} 选择
          </button>
          <button
            type="button"
            aria-label="检测 Codex app 路径"
            disabled={!!busy}
            onClick={() => void onDetect()}
            className="cursor-pointer text-[12px] font-semibold px-2.5 h-[34px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {spin('detect') ? <Loader2 size={13} className="animate-spin" /> : <ScanSearch size={13} />} 检测
          </button>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void onOpenConfig()}
            className="cursor-pointer text-[12px] font-semibold px-3 h-[32px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FileCog size={13} /> 打开 config.toml
          </button>
          <span className="text-[11px] text-[var(--text-muted)]">用系统默认编辑器打开 ~/.codex/config.toml</span>
        </div>
      </div>

      {/* 配额自动刷新:只读跳转到「保活」,不在此重复设置 */}
      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4 flex items-center justify-between gap-3">
        <div>
          <div className="text-[13px] font-semibold text-[var(--text-primary)] inline-flex items-center gap-1.5"><Gauge size={14} /> 配额自动刷新</div>
          <div className="text-[11px] text-[var(--text-muted)] mt-0.5">配额自动刷新 / 当前账号刷新间隔在「保活」统一设置。</div>
        </div>
        <button
          type="button"
          onClick={() => onNavigate?.('wakeup')}
          className="cursor-pointer text-[12px] font-semibold px-3 h-[32px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--primary-strong)] inline-flex items-center gap-1.5 shrink-0"
        >
          去保活设置 <ArrowRight size={13} />
        </button>
      </div>

      {/* 上下文与压缩阈值预设 */}
      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4 flex flex-col gap-3">
        <div className="text-[11px] font-bold text-[var(--text-muted)] tracking-wide">上下文与压缩阈值</div>
        <div className="inline-flex rounded-[10px] bg-[var(--bg-tertiary)] p-0.5 self-start">
          {PRESET_OPTIONS.map(([id, label]) => {
            const active = preset === id
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                disabled={spin('quick')}
                onClick={() => onPickPreset(id)}
                className={cn(
                  'cursor-pointer text-[12px] font-semibold px-3 h-[30px] rounded-[8px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                  active ? 'bg-[var(--bg-card)] text-[var(--primary-strong)] shadow-[var(--shadow-sm)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
                )}
              >
                {label}
              </button>
            )
          })}
        </div>
        <div className="text-[11px] text-[var(--text-muted)]">{PRESET_OPTIONS.find(([id]) => id === preset)?.[2]}</div>

        {preset === 'custom' && (
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3 pt-1">
            <label className="flex flex-col gap-1 text-[11px] text-[var(--text-secondary)]">
              上下文窗口
              <input
                type="number"
                min={1}
                aria-label="上下文窗口"
                value={customCtx}
                disabled={spin('quick')}
                onChange={(e) => setCustomCtx(e.target.value)}
                className="w-[140px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-3 h-[32px] text-[12px] font-mono-data text-[var(--text-primary)] tabular-nums outline-none focus:border-[var(--primary)] disabled:opacity-50"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--text-secondary)]">
              压缩阈值
              <input
                type="number"
                min={1}
                aria-label="压缩阈值"
                value={customCompact}
                disabled={spin('quick')}
                onChange={(e) => setCustomCompact(e.target.value)}
                className="w-[140px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-3 h-[32px] text-[12px] font-mono-data text-[var(--text-primary)] tabular-nums outline-none focus:border-[var(--primary)] disabled:opacity-50"
              />
            </label>
            <button
              type="button"
              disabled={spin('quick')}
              onClick={onSaveCustom}
              className="cursor-pointer text-[12px] font-semibold px-3 h-[32px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              保存阈值
            </button>
          </div>
        )}
      </div>

      {/* Codex 皮肤调试通道:冰茶只管通道(开关/重启/发现文件),皮肤由用户自己的 Agent 按 skill 设计注入 */}
      {skin && (() => {
        // 四象限:开+活=生效;开+死=等重启;关+活=重启后关闭;关+死=未开启。
        const phase = skin.enabled ? (skin.live ? 'active' : 'pending') : (skin.live ? 'draining' : 'off')
        const statusStyle = {
          active: 'border-[var(--success)]/40 bg-[var(--success)]/5',
          pending: 'border-[var(--warning)]/40 bg-[var(--warning)]/5',
          draining: 'border-[var(--warning)]/40 bg-[var(--warning)]/5',
          off: 'border-[var(--border-light)] bg-[var(--bg-tertiary)]',
        }[phase]
        const dotStyle = {
          active: 'bg-[var(--success)]',
          pending: 'bg-[var(--warning)]',
          draining: 'bg-[var(--warning)]',
          off: 'bg-[var(--text-muted)]',
        }[phase]
        const statusText = {
          active: <>通道已开启 · <span className="font-mono-data">127.0.0.1:{skin.port}</span> —— 你的 Agent 现在可以注入皮肤</>,
          pending: <>等待重启 —— 下次启动 Codex 将附加 <span className="font-mono-data">--remote-debugging-port={skin.port}</span></>,
          draining: <>开关已关闭,但 Codex 仍带调试端口运行 —— 重启后彻底关闭</>,
          off: <>未开启 —— Codex 以官方默认方式运行</>,
        }[phase]
        const showRestart = phase === 'pending' || phase === 'draining'
        return (
          <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4 flex flex-col gap-3">
            <Switch
              label="皮肤调试通道(实验性)"
              desc="为 Codex 桌面端开启本机 CDP 通道(仅 127.0.0.1),供你自己的 AI Agent 注入自定义皮肤。不修改官方安装包,关闭后重启即还原。"
              checked={skin.enabled}
              busy={spin('skin')}
              onToggle={() => void onToggleSkin()}
            />
            <div className={cn('flex items-center gap-2.5 rounded-[8px] border px-3 py-2 text-[12px]', statusStyle)}>
              <span className={cn('w-2 h-2 rounded-full shrink-0', dotStyle, phase === 'pending' && 'animate-pulse')} />
              <span className="flex-1 text-[var(--text-secondary)]">{statusText}</span>
              {showRestart && (
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void onSkinRestart()}
                  className="cursor-pointer text-[12px] font-semibold px-2.5 h-[28px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                >
                  {spin('skinRestart') ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                  {phase === 'draining' ? '重启关闭' : '重启 Codex 生效'}
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-[var(--text-muted)] inline-flex items-center gap-1"><Palette size={12} /> 皮肤 Skill(给 Agent 的换肤说明书 + 注入脚本):</span>
              <code className="text-[11px] font-mono-data text-[var(--text-secondary)] bg-[var(--bg-tertiary)] rounded px-1.5 py-0.5 break-all">{skin.skillDir}</code>
              <button
                type="button"
                onClick={() => void onCopySkillDir()}
                className="cursor-pointer text-[11px] font-semibold px-2 h-[26px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] inline-flex items-center gap-1 shrink-0"
              >
                <Copy size={11} /> {skinCopied ? '已复制' : '复制路径'}
              </button>
              <button
                type="button"
                disabled={spin('skinOpen')}
                onClick={() => void onOpenSkillFolder()}
                className="cursor-pointer text-[11px] font-semibold px-2 h-[26px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] inline-flex items-center gap-1 shrink-0 disabled:opacity-50"
              >
                <FolderOpen size={11} /> 打开文件夹
              </button>
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">
              把上面的路径丢给任意 Agent(如 Claude Code):「按这个 skill 给我的 Codex 换个皮肤」。冰茶不出预设、不做编辑器,也不写入任何 Agent 的配置。
              {/* 绑到端口真实暴露(live),而非开关意图 —— 关掉开关但端口仍在跑(残留)时才是真有风险的时刻。 */}
              {skin.live && (
                <span className="text-[var(--warning-deep)]"> 注意:调试端口正在运行,本机任何程序都可连接控制 Codex 界面,不需要时请关闭并重启 Codex。</span>
              )}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
