import { useState, useEffect, useMemo } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Search, ChevronRight, ChevronDown, Loader2, AlertCircle, MessageCircle, MessageSquare, ExternalLink } from 'lucide-react'
import * as api from '@/services/wails'
import { useT } from '@/i18n'

const CACHE_KEY = 'bcai_faq_cache'
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
        const faqItems = (data.items || []) as FaqItem[]
        const faqSettings = (data.settings || {}) as Record<string, string>
        if (faqItems.length > 0) {
          setItems(faqItems)
          setSettings(faqSettings)
          saveCache(faqItems, faqSettings)
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

  const toggleCategory = (cat: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(cat) ? next.delete(cat) : next.add(cat)
      return next
    })
  }

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
      setExpanded(new Set([...grouped.map(([cat]) => cat), ...items.map((i) => i.id)]))
    }
  }, [search, grouped, items])

  return (
    <div className="max-w-[680px] flex flex-col gap-4 pt-1">
      <p className="text-[12px] text-[var(--text-muted)]">{t('faq.subtitle')}</p>

      {/* Search */}
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('faq.searchPlaceholder')}
          className="pl-9 h-[40px]"
        />
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center gap-2 py-12 text-[var(--text-muted)] text-[13px]">
          <Loader2 size={16} className="animate-spin" />
          {t('common.loading')}
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="rounded-[10px] border border-[var(--danger)] bg-[var(--danger)]/5 px-4 py-3 flex items-center gap-2 text-[13px] text-[var(--danger)]">
          <AlertCircle size={15} />
          {error}
        </div>
      )}

      {/* FAQ groups */}
      {!loading && grouped.length === 0 && !error && (
        <div className="text-center py-12 text-[var(--text-muted)] text-[13px]">
          {search ? t('faq.noMatch') : t('faq.empty')}
        </div>
      )}

      {!loading && grouped.map(([category, categoryItems]) => {
        const isCatExpanded = expanded.has(category)
        return (
          <Card key={category}>
            <button
              onClick={() => toggleCategory(category)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors rounded-t-[10px] cursor-pointer"
            >
              <div className="flex items-center gap-2">
                {isCatExpanded
                  ? <ChevronDown size={15} className="text-[var(--primary)]" />
                  : <ChevronRight size={15} className="text-[var(--text-muted)]" />
                }
                <span className="text-[13px] font-semibold text-[var(--text-primary)]">{category}</span>
              </div>
              <span className="text-[11px] text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-2 py-0.5 rounded-full">
                {categoryItems.length}
              </span>
            </button>

            {isCatExpanded && (
              <div className="border-t border-[var(--border-light)]">
                {categoryItems.map((item, idx) => {
                  const isOpen = expanded.has(item.id)
                  return (
                    <div
                      key={item.id}
                      className={idx < categoryItems.length - 1 ? 'border-b border-[var(--border-light)]' : ''}
                    >
                      <button
                        onClick={() => toggleItem(item.id)}
                        className="w-full flex items-start gap-2.5 px-4 py-3 hover:bg-[var(--bg-hover)]/50 transition-colors text-left cursor-pointer"
                      >
                        <ChevronRight
                          size={13}
                          className={`mt-[3px] flex-shrink-0 transition-transform duration-150 text-[var(--text-muted)] ${isOpen ? 'rotate-90' : ''}`}
                        />
                        <span className="text-[13px] text-[var(--text-primary)] font-medium leading-[1.5]">
                          {item.question}
                        </span>
                      </button>
                      {isOpen && (
                        <div
                          className="px-4 pb-3 ml-[26px] text-[12px] text-[var(--text-secondary)] leading-[1.7] faq-answer"
                          dangerouslySetInnerHTML={{ __html: item.answer }}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
        )
      })}

      {/* 意见反馈卡片 — 常驻,不依赖 FAQ 是否加载成功;点击打开用户中心 */}
      {!loading && (
        <Card>
          <CardContent className="flex items-center gap-3 py-3">
            <div className="w-9 h-9 rounded-[10px] bg-[var(--bg-tertiary)] flex items-center justify-center shrink-0 text-[var(--text-primary)]">
              <MessageSquare size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-[var(--text-primary)]">{t('faq.githubTitle')}</div>
              <div className="text-[11px] text-[var(--text-muted)]">{t('faq.githubDesc')}</div>
            </div>
            <button
              onClick={() => api.openURL(api.PORTAL_URLS.home)}
              className="flex items-center gap-1 text-[11px] text-[var(--primary-strong)] hover:underline shrink-0 cursor-pointer"
            >
              {t('faq.githubCta')} <ExternalLink size={11} />
            </button>
          </CardContent>
        </Card>
      )}

      {/* Contact card */}
      {!loading && items.length > 0 && (
        <Card>
          <CardContent className="flex items-center gap-3 py-3">
            <div className="w-9 h-9 rounded-[10px] bg-[var(--primary-light)] flex items-center justify-center shrink-0">
              <MessageCircle size={18} className="text-[var(--primary)]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-[var(--text-primary)]">{t('faq.noAnswer')}</div>
              <div className="text-[11px] text-[var(--text-muted)]">
                {settings.contact_wechat
                  ? t('faq.wechatContact', { wechat: settings.contact_wechat })
                  : t('faq.groupContact')}
              </div>
            </div>
            <a
              href={api.SITE_URLS.faq}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-[11px] text-[var(--primary-strong)] hover:underline shrink-0"
            >
              {t('faq.viewFull')} <ExternalLink size={11} />
            </a>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
