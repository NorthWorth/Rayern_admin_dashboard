import type { ReactNode } from 'react'
import { clsx } from '../../lib/utils'

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={clsx('rounded-lg border border-ink-200 bg-white', className)}>{children}</section>
}

export function CardHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-200 px-4 py-3">
      <div>
        <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
        {subtitle ? <p className="mt-0.5 text-xs text-ink-500">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx('p-4', className)}>{children}</div>
}
