import { afterEach, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { cleanup } from '@testing-library/react'

afterEach(cleanup)

beforeEach(() => {
  document.body.innerHTML = ''
})
