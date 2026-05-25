import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

interface StatCardProps {
  icon: LucideIcon
  value: string | number
  label: string
  color?: string
}

export function StatCard({ icon: Icon, value, label, color = 'text-[var(--primary)]' }: StatCardProps) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-1">
          <Icon size={15} className="text-[var(--text-muted)]" />
          <span className={cn('text-xl font-bold font-mono-data tracking-tight', color)}>{value}</span>
        </div>
        <span className="text-[11px] text-[var(--text-muted)]">{label}</span>
      </CardContent>
    </Card>
  )
}
