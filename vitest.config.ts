import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // A production build emits JS into dist; run the source tests only, in either order.
    include: ['src/**/*.test.ts', 'web/src/**/*.test.ts'],
  },
})
