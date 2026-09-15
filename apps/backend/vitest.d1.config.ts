import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/worker/d1.test.ts'] },
})
