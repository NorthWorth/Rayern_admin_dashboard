import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['../client/src/testSetup.ts'],
    include: ['../client/src/__tests__/**/*.test.ts', '../client/src/__tests__/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/client',
      reporter: ['text-summary', 'lcov'],
      include: ['../client/src/**/*.{ts,tsx}'],
      exclude: ['../client/src/**/*.d.ts', '../client/src/testSetup.*'],
    },
  },
})
