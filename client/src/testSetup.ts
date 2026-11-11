import { afterEach, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { cleanup } from '@testing-library/react'

afterEach(cleanup)

beforeEach(() => {
  document.body.innerHTML = ''
})

/**
 * Some jsdom/Node combinations expose `globalThis.localStorage` as undefined
 * (Node's own experimental Storage is not initialised without
 * `--localstorage-file`). The API client persists the admin session there, so
 * the suite installs the standard in-memory Storage instead of failing on a
 * missing browser primitive — the production code path stays untouched.
 */
if (!globalThis.localStorage) {
  const store = new Map<string, string>()
  const storage: Storage = {
    get length(): number {
      return store.size
    },
    clear: (): void => {
      store.clear()
    },
    getItem: (key: string): string | null => (store.has(key) ? (store.get(key) as string) : null),
    key: (index: number): string | null => [...store.keys()][index] ?? null,
    removeItem: (key: string): void => {
      store.delete(key)
    },
    setItem: (key: string, value: string): void => {
      store.set(key, String(value))
    },
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
}
