import { useCallback, useEffect, useState } from 'react'
import {
  Server, Plus, Pencil, Trash2, Plug2, ListPlus, Loader2, Check, AlertTriangle, X,
} from 'lucide-react'
import {
  type ModelProvider, type ModelProviderInput, type ModelProviderWireApi,
  type ModelProviderConnTestResult,
  listModelProviders, saveModelProvider, deleteModelProvider,
  testModelProvider, listModelProviderModels,
} from '@/services/localApi'
import { cn } from '@/lib/utils'

/**
 * 供应商 tab —— 自定义 OpenAI 兼容模型供应商(codex 喂号)+ 动态模型目录。
 *
 * 列表(名称 / baseURL / 模型数)+ 新建/编辑弹窗(名称 / baseURL / apiKey / wireApi / 模型目录)+
 * 删除 + 连通测试(testModelProvider)+ 拉取模型列表(listModelProviderModels 回填 modelCatalog)。
 *
 * 红线:这是自定义供应商喂号路径,与远程租号无关。视觉沿用 GFA token(琥珀单色、克制分区、
 * 对比 ≥4.5:1),apiKey 输入掩码展示(type=password),只用已封装的 localApi 函数。
 */

const WIRE_OPTIONS: [ModelProviderWireApi, string][] = [
  ['responses', 'Responses(codex 原生)'],
  ['chat_completions', 'Chat Completions(OpenAI 兼容)'],
]

/** 掩码 apiKey:保留前 6 与后 4,中间打码;短值则全打码。 */
function maskKey(value: string): string {
  if (!value) return '—'
  if (value.length <= 10) return value.slice(0, 2) + '••••'
  return `${value.slice(0, 6)}••••${value.slice(-4)}`
}

interface DraftState {
  id?: string
  name: string
  baseURL: string
  apiKey: string
  wireApi: ModelProviderWireApi
  modelCatalog: string
}

function emptyDraft(): DraftState {
  return { name: '', baseURL: '', apiKey: '', wireApi: 'responses', modelCatalog: '' }
}

function draftFrom(p: ModelProvider): DraftState {
  return {
    id: p.id,
    name: p.name,
    baseURL: p.baseURL,
    apiKey: p.apiKey,
    wireApi: p.wireApi,
    modelCatalog: (p.modelCatalog || []).join(', '),
  }
}

function parseCatalog(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

export function LocalModelProvidersTab() {
  const [list, setList] = useState<ModelProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  // 新建/编辑弹窗
  const [editing, setEditing] = useState<DraftState | null>(null)
  const [saving, setSaving] = useState(false)

  // 连通测试结果(按 provider id)
  const [conn, setConn] = useState<Record<string, ModelProviderConnTestResult>>({})

  const refresh = useCallback(async () => {
    try {
      setList((await listModelProviders()) || [])
      setErr('')
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const onSave = async () => {
    if (!editing || !editing.name.trim() || !editing.baseURL.trim()) return
    setSaving(true)
    setErr('')
    try {
      const input: ModelProviderInput = {
        id: editing.id,
        name: editing.name.trim(),
        baseURL: editing.baseURL.trim(),
        apiKey: editing.apiKey.trim(),
        wireApi: editing.wireApi,
        modelCatalog: parseCatalog(editing.modelCatalog),
      }
      await saveModelProvider(input)
      setEditing(null)
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setSaving(false)
    }
  }

  const onDelete = async (id: string) => {
    setBusy(`del-${id}`)
    setErr('')
    try {
      await deleteModelProvider(id)
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onTest = async (id: string) => {
    setBusy(`test-${id}`)
    setErr('')
    try {
      const r = await testModelProvider(id)
      setConn((prev) => ({ ...prev, [id]: r }))
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onFetchModels = async (id: string) => {
    setBusy(`models-${id}`)
    setErr('')
    try {
      await listModelProviderModels(id)
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {err && <div className="rounded-[8px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2 text-[12px] text-[var(--danger)] break-all">{err}</div>}

      {/* 说明 + 新建 */}
      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-[10px] bg-[var(--bg-tertiary)] flex items-center justify-center shrink-0">
            <Server size={18} className="text-[var(--text-secondary)]" />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-[var(--text-primary)]">自定义模型供应商</div>
            <div className="text-[11px] text-[var(--text-muted)] mt-0.5">OpenAI 兼容供应商喂号:codex 走这些 baseURL/apiKey 转发,可拉取动态模型目录。</div>
          </div>
        </div>
        <button
          onClick={() => setEditing(emptyDraft())}
          className="cursor-pointer text-[12px] font-semibold px-3 h-[34px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] inline-flex items-center gap-1.5 shrink-0"
        >
          <Plus size={14} /> 新建供应商
        </button>
      </div>

      {/* 列表 */}
      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[var(--border-light)] bg-[var(--bg-tertiary)]/50">
          <span className="text-[11px] font-bold text-[var(--text-muted)] tracking-wide">供应商 · {list.length}</span>
        </div>
        {loading ? (
          <div className="px-4 py-10 text-center text-[12px] text-[var(--text-muted)]">加载中…</div>
        ) : list.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <div className="text-[13px] font-semibold text-[var(--text-primary)] mb-1">还没有自定义供应商</div>
            <div className="text-[12px] text-[var(--text-muted)] mb-4">新建一个 OpenAI 兼容供应商(baseURL + apiKey),即可用它的模型喂号。</div>
            <button
              onClick={() => setEditing(emptyDraft())}
              className="cursor-pointer text-[12px] font-semibold px-3 h-[32px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] inline-flex items-center gap-1.5"
            >
              <Plus size={14} /> 新建供应商
            </button>
          </div>
        ) : (
          list.map((p) => {
            const r = conn[p.id]
            const testing = busy === `test-${p.id}`
            const fetching = busy === `models-${p.id}`
            const deleting = busy === `del-${p.id}`
            return (
              <div key={p.id} className="px-4 py-3 border-t border-[var(--border-light)] first:border-t-0">
                <div className="grid grid-cols-[1fr_auto] gap-3 items-start">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-[13px] text-[var(--text-primary)] truncate">{p.name}</span>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                        {p.wireApi === 'chat_completions' ? 'Chat Completions' : 'Responses'}
                      </span>
                      <span className="text-[11px] text-[var(--text-muted)]">{(p.modelCatalog || []).length} 个模型</span>
                    </div>
                    <div className="text-[11px] font-mono-data text-[var(--text-muted)] truncate mt-0.5">{p.baseURL}</div>
                    <div className="text-[11px] font-mono-data text-[var(--text-muted)] truncate mt-0.5">Key {maskKey(p.apiKey)}</div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => void onTest(p.id)}
                      disabled={testing}
                      aria-label="连通测试"
                      title="对 /models 端点发最小真请求"
                      className="cursor-pointer text-[11px] font-semibold px-2.5 h-[28px] rounded-[7px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {testing ? <Loader2 size={13} className="animate-spin" /> : <Plug2 size={13} />} 连通测试
                    </button>
                    <button
                      onClick={() => void onFetchModels(p.id)}
                      disabled={fetching}
                      aria-label="拉取模型列表"
                      title="拉取动态模型目录并回填"
                      className="cursor-pointer text-[11px] font-semibold px-2.5 h-[28px] rounded-[7px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {fetching ? <Loader2 size={13} className="animate-spin" /> : <ListPlus size={13} />} 拉取模型列表
                    </button>
                    <button
                      onClick={() => setEditing(draftFrom(p))}
                      aria-label="编辑供应商"
                      title="编辑名称 / baseURL / apiKey / 协议 / 模型目录"
                      className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)] w-7 h-7 inline-flex items-center justify-center rounded-[7px] hover:bg-[var(--bg-hover)]"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => void onDelete(p.id)}
                      disabled={deleting}
                      aria-label="删除供应商"
                      title="删除该供应商"
                      className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--danger)] w-7 h-7 inline-flex items-center justify-center rounded-[7px] hover:bg-[var(--danger)]/10 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    </button>
                  </div>
                </div>

                {/* 模型目录 chips */}
                {(p.modelCatalog || []).length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    {(p.modelCatalog || []).map((m) => (
                      <span key={m} className="text-[10px] font-mono-data px-1.5 py-0.5 rounded-[5px] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">{m}</span>
                    ))}
                  </div>
                )}

                {/* 连通测试结果 */}
                {r && (
                  <div
                    className={cn(
                      'rounded-[8px] border px-2.5 py-1.5 text-[11px] flex items-center gap-2 mt-2',
                      r.ok
                        ? 'border-[var(--success)] bg-[var(--success)]/10 text-[var(--text-secondary)]'
                        : 'border-[var(--danger)] bg-[var(--danger)]/5 text-[var(--danger)]',
                    )}
                  >
                    {r.ok ? <Check size={13} className="text-[var(--success)] shrink-0" /> : <AlertTriangle size={13} className="text-[var(--danger)] shrink-0" />}
                    {r.ok ? (
                      <span>连通正常 · HTTP <span className="font-mono-data text-[var(--text-primary)]">{r.status}</span> · 延迟 <span className="font-mono-data text-[var(--text-primary)] tabular-nums">{r.latencyMs}</span> ms{r.model ? <> · <span className="font-mono-data text-[var(--text-primary)]">{r.model}</span></> : null}</span>
                    ) : (
                      <span className="break-all">连通失败{r.status ? ` · HTTP ${r.status}` : ''}{r.err ? ` · ${r.err}` : ''}</span>
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* 新建/编辑弹窗 */}
      {editing && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onClick={() => setEditing(null)}>
          <div className="w-[460px] max-w-[90vw] rounded-[12px] bg-[var(--bg-card)] border border-[var(--border)] shadow-lg p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] font-bold text-[var(--text-primary)]">{editing.id ? '编辑供应商' : '新建供应商'}</span>
              <button onClick={() => setEditing(null)} aria-label="关闭" className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={15} /></button>
            </div>
            <div className="text-[11px] text-[var(--text-muted)] mb-3">OpenAI 兼容供应商,凭证只留在本机。wireApi 留默认即可按 baseURL 归一。</div>
            <div className="flex flex-col gap-2.5">
              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[var(--text-secondary)]">供应商名称
                <input aria-label="供应商名称" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="如「DeepSeek」「我的中转」" className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[34px] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--primary)]" />
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[var(--text-secondary)]">Base URL
                <input aria-label="Base URL" value={editing.baseURL} onChange={(e) => setEditing({ ...editing, baseURL: e.target.value })} placeholder="https://api.deepseek.com/v1" className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[34px] text-[12px] font-mono-data text-[var(--text-primary)] outline-none focus:border-[var(--primary)]" />
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[var(--text-secondary)]">API Key
                <input type="password" aria-label="API Key" value={editing.apiKey} onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })} placeholder="sk-..." className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[34px] text-[12px] font-mono-data text-[var(--text-primary)] outline-none focus:border-[var(--primary)]" />
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[var(--text-secondary)]">协议线(wireApi)
                <select aria-label="协议线(wireApi)" value={editing.wireApi} onChange={(e) => setEditing({ ...editing, wireApi: e.target.value as ModelProviderWireApi })} className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[34px] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--primary)]">
                  {WIRE_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[var(--text-secondary)]">模型目录(逗号分隔)
                <input aria-label="模型目录(逗号分隔)" value={editing.modelCatalog} onChange={(e) => setEditing({ ...editing, modelCatalog: e.target.value })} placeholder="可留空,用「拉取模型列表」自动回填" className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[34px] text-[12px] font-mono-data text-[var(--text-primary)] outline-none focus:border-[var(--primary)]" />
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setEditing(null)} className="cursor-pointer text-[12px] font-semibold px-3 h-[32px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">取消</button>
              <button onClick={onSave} disabled={saving || !editing.name.trim() || !editing.baseURL.trim()} className="cursor-pointer text-[12px] font-semibold px-3 h-[32px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} 保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
