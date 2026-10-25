import React from 'react'

interface KpiCardProps {
  label: string
  value: string
  sub?: string
  tone?: 'green' | 'red' | 'amber' | 'neutral' | 'blue'
}

export function KpiCard({ label, value, sub, tone }: KpiCardProps) {
  const toneClass = {
    green: 'border-l-emerald-500',
    red: 'border-l-red-500',
    amber: 'border-l-amber-500',
    neutral: 'border-l-ink-300',
    blue: 'border-l-blue-500',
  }[tone ?? 'neutral'] ?? 'border-l-ink-300'

  return (
    <div className={`rounded-lg border border-ink-200 bg-white p-4 shadow-sm ${toneClass} border-l-4`}>
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-ink-900">{value}</p>
      {sub ? <p className="mt-1 text-xs text-ink-500">{sub}</p> : null}
    </div>
  )
}
