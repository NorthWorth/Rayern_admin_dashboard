import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { clsx } from '../../lib/utils'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  children: ReactNode
}

export function Button({ variant = 'secondary', size = 'md', className, children, ...rest }: ButtonProps) {
  return (
    <button
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-md border font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-ink-400 disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'border-ink-900 bg-ink-900 text-white hover:bg-ink-700',
        variant === 'secondary' && 'border-ink-200 bg-white text-ink-800 hover:bg-ink-100',
        variant === 'ghost' && 'border-transparent bg-transparent text-ink-600 hover:bg-ink-100 hover:text-ink-900',
        variant === 'danger' && 'border-red-200 bg-white text-red-700 hover:bg-red-50',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
