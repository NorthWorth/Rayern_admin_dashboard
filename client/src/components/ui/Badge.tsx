import React from 'react'

interface BadgeProps {
  children: React.ReactNode
  tone?: 'green' | 'red' | 'amber' | 'neutral' | 'blue'
  className?: string
}

export function Badge({ children, tone = 'neutral', className }: BadgeProps) {
  const toneClass = {
    green: 'bg-emerald-100 text-emerald-800',
    red: 'bg-red-100 text-red-800',
    amber: 'bg-amber-100 text-amber-800',
    neutral: 'bg-ink-100 text-ink-700',
    blue: 'bg-blue-100 text-blue-800',
  }[tone] ?? 'bg-ink-100 text-ink-700'

  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${toneClass} ${className ?? ''}`}>
      {children}
    </span>
  )
}
