import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Preview/dev server binds to 0.0.0.0 and respects the injected PORT so the
// Freebuff preview can reach it. HMR is intentionally left disabled.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
    hmr: false,
  },
  preview: {
    host: '0.0.0.0',
    port: Number(process.env.PORT) || 4173,
    strictPort: false,
  },
})
