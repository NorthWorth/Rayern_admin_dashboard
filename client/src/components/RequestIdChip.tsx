import { useState } from 'react'

/**
 * Copyable request id, shared by every diagnostics surface (Rayern's own logs
 * and this backend's outbound sync diagnostics). Shortened for display, full
 * value on the clipboard.
 */
export function RequestIdChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={`Copy request id ${value}`}
      onClick={() => {
        if (!navigator.clipboard?.writeText) return
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => undefined)
      }}
      className="inline-flex items-center gap-1.5 rounded border border-ink-200 bg-ink-50 px-1.5 py-0.5 font-mono text-[11px] text-ink-700 hover:border-ink-300 hover:bg-ink-100"
      title="Copy request id"
    >
      {value.slice(0, 12)}…
      <span className="font-sans text-[10px] font-semibold uppercase tracking-wide text-ink-500">
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  )
}
