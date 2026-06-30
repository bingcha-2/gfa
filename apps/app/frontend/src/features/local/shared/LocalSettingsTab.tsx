import { useCallback, useEffect, useState } from 'react'
import {
  Settings2, FolderSearch, ScanSearch, FileCog, Gauge, ArrowRight, Loader2,
} from 'lucide-react'
import {
  type CodexSettings,
  getCodexSettings, saveCodexSettings,
  getCodexQuickConfig, saveCodexQuickConfig,
  browseForPath, detectCodexAppPath, openCodexConfigToml,
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
          checked ? 'bg-[var(--primary)]' : 'bg-[#cbd2dc]',
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

  const load = useCallback(async () => {
    try {
      const [s, q] = await Promise.all([getCodexSettings(), getCodexQuickConfig()])
      setSettings(s)
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
    </div>
  )
}
