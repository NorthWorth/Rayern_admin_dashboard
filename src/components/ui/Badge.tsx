import type { ReactNode } from 'react'
import { clsx } from '../../lib/utils'

export type BadgeTone = 'neutral' | 'green' | 'amber' | 'red' | 'blue'

const toneClasses: Record<BadgeTone, string> = {
  neutral: 'bg-ink-100 text-ink-600 border-ink-200',
  green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  red: 'bg-red-50 text-red-700 border-red-200',
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
}

export function Badge({ tone = 'neutral', className, children }: { tone?: BadgeTone; className?: string; children: ReactNode }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium', toneClasses[tone], className)}>
      {children}
    </span>
  )
}

export function Dot({ tone }: { tone: BadgeTone }) {
  const color = tone === 'green' ? 'bg-emerald-500' : tone === 'amber' ? 'bg-amber-500' : tone === 'red' ? 'bg-red-500' : tone === 'blue' ? 'bg-blue-500' : 'bg-ink-400'
  return <span className={clsx('inline-block h-1.5 w-1.5 rounded-full', color)} />
}

export function StatusBadge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <Badge tone={tone}>
      <Dot tone={tone} />
      {children}
    </Badge>
  )
}
