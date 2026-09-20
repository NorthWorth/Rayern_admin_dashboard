import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { clsx } from '../../lib/utils'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim())
}

interface TokenInputProps {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  ariaLabel: string
}

/** Multi-recipient input: type an address and press Enter or comma to add it. */
export function TokenInput({ value, onChange, placeholder, ariaLabel }: TokenInputProps) {
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState(false)

  const addDraft = (): void => {
    const parts = draft.split(/[,;\s]+/).map((p) => p.trim()).filter(Boolean)
    const valid = parts.filter(isValidEmail)
    const invalidParts = parts.filter((p) => !isValidEmail(p))
    if (parts.length === 0) return
    if (invalidParts.length > 0) {
      setInvalid(true)
      return
    }
    const merged = [...value]
    for (const v of valid) {
      if (!merged.some((m) => m.toLowerCase() === v.toLowerCase())) merged.push(v)
    }
    onChange(merged)
    setDraft('')
    setInvalid(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addDraft()
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div className={clsx('flex flex-wrap items-center gap-1.5 rounded-md border bg-white px-2 py-1.5', invalid ? 'border-red-300' : 'border-ink-200')}>
      {value.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded bg-ink-100 px-1.5 py-0.5 text-xs text-ink-700">
          {v}
          <button
            type="button"
            aria-label={`Remove ${v}`}
            className="text-ink-400 hover:text-ink-700 focus-visible:outline-none"
            onClick={() => onChange(value.filter((x) => x !== v))}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        </span>
      ))}
      <input
        className="min-w-[9rem] flex-1 bg-transparent py-0.5 text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none"
        value={draft}
        aria-label={ariaLabel}
        placeholder={value.length === 0 ? placeholder : undefined}
        onChange={(e) => { setDraft(e.target.value); setInvalid(false) }}
        onKeyDown={onKeyDown}
        onBlur={addDraft}
      />
      {invalid ? <span className="w-full text-[11px] text-red-600">Enter a valid email address, then press Enter</span> : null}
    </div>
  )
}
