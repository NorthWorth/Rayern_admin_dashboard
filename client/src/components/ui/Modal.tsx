import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { clsx } from '../../lib/utils'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  width?: 'md' | 'lg' | 'xl'
  children: ReactNode
}

/**
 * Dialog structure:
 *
 *   fixed overlay (covers viewport, never scrolls)
 *   └── centered dialog (max-h capped to the viewport, flex column)
 *       └── scrollable content area (overflow-y-auto)
 *
 * The dialog caps itself to the viewport height and scrolls internally, so
 * tall content (e.g. the email composer) stays usable on short viewports.
 * The backdrop never scrolls, and a dialog dismissal requires a full
 * press + release on the backdrop itself — scrolling, scrollbar drags, or
 * interactions inside the dialog can never close it.
 */
export function Modal({ open, onClose, title, description, width = 'md', children }: ModalProps) {
  const pressStartedOnBackdrop = useRef(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  const widths = { md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 sm:p-6"
      role="presentation"
      onMouseDown={(e) => {
        pressStartedOnBackdrop.current = e.target === e.currentTarget
      }}
      onMouseUp={(e) => {
        // Close only for a complete press + release on the backdrop itself,
        // so drags (text selection, scrollbar use) never dismiss the dialog.
        if (pressStartedOnBackdrop.current && e.target === e.currentTarget) onClose()
        pressStartedOnBackdrop.current = false
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx(
          'flex max-h-full w-full flex-col overflow-hidden rounded-lg border border-ink-200 bg-white shadow-xl',
          widths[width],
        )}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-ink-200 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
            {description ? <p className="mt-0.5 text-xs text-ink-500">{description}</p> : null}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-300">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  )
}
