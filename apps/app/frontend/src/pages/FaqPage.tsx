import { useState, useEffect, useMemo } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Search, ChevronDown, Loader2, AlertCircle, BookOpen, MessageCircle, MessageSquare, ExternalLink } from 'lucide-react'
import * as api from '@/services/wails'
import { useT } from '@/i18n'

const LEGACY_CACHE_KEY = 'bcai_faq_cache'
const CACHE_KEY = 'bcai_faq_cache_v2'
const CACHE_TTL = 24 * 60 * 60 * 1000 // 24h

interface FaqItem {
  id: string
  category: string
  question: string
  answer: string
  sortOrder: number
}

interface FaqCache {
  items: FaqItem[]
  settings: Record<string, string>
  ts: number
}

function loadCache(): FaqCache | null {
  try {
    // v1 may contain the previous owner's contact details. Never render it.
    localStorage.removeItem(LEGACY_CACHE_KEY)
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const cache: FaqCache = JSON.parse(raw)
    if (Date.now() - cache.ts > CACHE_TTL) return null
    return cache
  } catch { return null }
}

function saveCache(items: FaqItem[], settings: Record<string, string>) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ items, settings, ts: Date.now() }))
  } catch { /* quota exceeded — ignore */ }
}

export function FaqPage() {
  const t = useT()
  const [items, setItems] = useState<FaqItem[]>([])
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedCategory, setSelectedCategory] = useState('全部')

  useEffect(() => {
    // Show cache immediately, then refresh in background
    const cache = loadCache()
    if (cache) {
      setItems(cache.items)
      setSettings(cache.settings)
      setLoading(false)
    }

    // Fetch via Wails IPC (Go backend), bypassing CORS
    api.getFaqData()
      .then((data) => {
        // The Go bridge fetches these endpoints independently, so update whichever
        // payload arrived instead of tying contact refresh to a non-empty FAQ list.
        const hasItems = Array.isArray(data.items)
        const hasSettings = data.settings !== undefined
        const faqItems = (data.items || []) as FaqItem[]
        const faqSettings = (data.settings || {}) as Record<string, string>
        if (hasItems) {
          setItems(faqItems)
        }
        if (hasSettings) {
          setSettings(faqSettings)
        }
        if (hasItems || hasSettings) {
          saveCache(
            hasItems ? faqItems : cache?.items || [],
            hasSettings ? faqSettings : cache?.settings || {},
          )
        }
        setLoading(false)
        setError('')
      })
      .catch(() => {
        if (!cache) setError(t('faq.loadFailed'))
        setLoading(false)
      })
  }, [])

  // Group by category, filter by search
  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = q
      ? items.filter((i) => i.question.toLowerCase().includes(q) || i.answer.toLowerCase().includes(q) || i.category.toLowerCase().includes(q))
      : items

    const map = new Map<string, FaqItem[]>()
    for (const item of filtered) {
      const list = map.get(item.category) || []
      list.push(item)
      map.set(item.category, list)
    }
    return Array.from(map.entries())
  }, [items, search])

  const toggleItem = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // Auto-expand all categories when searching
  useEffect(() => {
    if (search.trim()) {
      setExpanded(new Set(items.map((item) => item.id)))
    }
  }, [search, items])

  const visibleItems = useMemo(() => grouped.flatMap(([category, categoryItems]) => selectedCategory === '全部' || selectedCategory === category ? categoryItems : []), [grouped, selectedCategory])

  return (
    <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4 pt-3">
      <div className="flex items-end justify-between gap-4"><div><h2 className="text-[19px] font-bold tracking-tight text-[var(--text-primary)]">{t('nav.faq')}</h2><p className="mt-1 text-[11px] text-[var(--text-secondary)]">{t('faq.subtitle')}</p></div><button type="button" onClick={() => api.openURL(api.PORTAL_URLS.support)} className="flex h-8 items-center gap-1.5 rounded-[8px] bg-[var(--primary)] px-3 text-[11px] font-semibold text-[var(--primary-ink)] hover:bg-[var(--primary-strong)]">{t('faq.supportCta')}<ExternalLink size={11} /></button></div>

      <div className="relative"><Search size={14} className="absolute left-3 top-3 text-[var(--text-muted)]" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('faq.searchPlaceholder')} className="h-10 pl-10" /></div>

      {loading && <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-[var(--text-muted)]"><Loader2 size={16} className="animate-spin" />{t('common.loading')}</div>}
      {error && !loading && <div className="flex items-center gap-2 rounded-[10px] border border-[var(--danger)] bg-[var(--danger)]/5 px-4 py-3 text-[13px] text-[var(--danger)]"><AlertCircle size={15} />{error}</div>}

      {!loading && !error && (
        <div className="grid grid-cols-[160px_1fr] gap-5">
          <aside className="space-y-1">
            <button type="button" onClick={() => setSelectedCategory('全部')} className={`flex h-9 w-full items-center justify-between rounded-[9px] px-3 text-[10px] font-semibold ${selectedCategory === '全部' ? 'bg-[var(--primary-light)] text-[var(--primary-strong)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}><span>全部</span><span className="font-mono-data text-[8px] opacity-60">{items.length}</span></button>
            {grouped.map(([category, categoryItems]) => <button key={category} type="button" onClick={() => setSelectedCategory(category)} className={`flex h-9 w-full items-center justify-between rounded-[9px] px-3 text-[10px] font-semibold ${selectedCategory === category ? 'bg-[var(--primary-light)] text-[var(--primary-strong)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}><span className="truncate">{category}</span><span className="font-mono-data text-[8px] opacity-60">{categoryItems.length}</span></button>)}
          </aside>

          <section className="overflow-hidden rounded-[14px] border border-[var(--border-light)] bg-[var(--bg-card)]">
            {visibleItems.length === 0 ? <div className="py-12 text-center text-[12px] text-[var(--text-muted)]">{search ? t('faq.noMatch') : t('faq.empty')}</div> : visibleItems.map((item) => {
              const isOpen = expanded.has(item.id)
              return <div key={item.id} className="border-b border-[var(--border-light)] last:border-0"><button type="button" onClick={() => toggleItem(item.id)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-[var(--bg-hover)]"><span className="grid h-7 w-7 place-items-center rounded-[8px] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"><BookOpen size={13} /></span><span className="flex-1 text-[11px] font-semibold text-[var(--text-primary)]">{item.question}</span><ChevronDown size={14} className={`text-[var(--text-muted)] transition-transform ${isOpen ? 'rotate-180' : ''}`} /></button>{isOpen && <div className="faq-answer px-14 pb-4 text-[10px] leading-6 text-[var(--text-secondary)]" dangerouslySetInnerHTML={{ __html: item.answer }} />}</div>
            })}
          </section>
        </div>
      )}

      {!loading && <div className="grid grid-cols-2 gap-3"><Card><CardContent className="flex items-center gap-3 py-3"><span className="grid h-9 w-9 place-items-center rounded-[10px] bg-[var(--bg-tertiary)]"><MessageSquare size={17} /></span><div className="min-w-0 flex-1"><div className="text-[11px] font-semibold text-[var(--text-primary)]">{t('faq.githubTitle')}</div><div className="truncate text-[9px] text-[var(--text-muted)]">{t('faq.githubDesc')}</div></div><button onClick={() => api.openURL(api.PORTAL_URLS.home)} className="text-[9px] font-semibold text-[var(--primary-strong)]">{t('faq.githubCta')}</button></CardContent></Card><Card><CardContent className="flex items-center gap-3 py-3"><span className="grid h-9 w-9 place-items-center rounded-[10px] bg-[var(--primary-light)] text-[var(--primary-strong)]"><MessageCircle size={17} /></span><div className="min-w-0 flex-1"><div className="text-[11px] font-semibold text-[var(--text-primary)]">{settings.contact_name || t('faq.noAnswer')}</div><div className="truncate text-[9px] text-[var(--text-muted)]">{settings.contact_wechat ? t('faq.wechatContact', { wechat: settings.contact_wechat }) : t('faq.groupContact')}</div></div><a href={api.SITE_URLS.faq} target="_blank" rel="noopener noreferrer" className="text-[9px] font-semibold text-[var(--primary-strong)]">{t('faq.viewFull')}</a></CardContent></Card></div>}
    </div>
  )
}
