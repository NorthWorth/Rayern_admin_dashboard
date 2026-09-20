import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { clsx } from '../../lib/utils'

interface ToastItem {
  id: number
  tone: 'success' | 'error' | 'info'
  message: string
}

interface ToastContextValue {
  showToast: (tone: ToastItem['tone'], message: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const showToast = useCallback((tone: ToastItem['tone'], message: string) => {
    const id = nextId.current++
    setToasts((prev) => [...prev, { id, tone, message }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 4200)
  }, [])

  const value = useMemo(() => ({ showToast }), [showToast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={clsx(
              'pointer-events-auto rounded-md border px-3.5 py-2.5 text-sm shadow-md',
              t.tone === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-800',
              t.tone === 'error' && 'border-red-200 bg-red-50 text-red-800',
              t.tone === 'info' && 'border-ink-200 bg-white text-ink-800',
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
