import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  // This forwards the authenticated API. For local UI work use the isolated fake preview server.
  server: { proxy: { '/api': 'http://127.0.0.1:18799' }, strictPort: true },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
})
