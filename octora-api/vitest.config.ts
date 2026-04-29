import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '#app': path.resolve(__dirname, './src/app.ts'),
      '#domain': path.resolve(__dirname, './src/domain/index.ts'),
      '#indexer': path.resolve(__dirname, './src/indexer/index.ts'),
      '#adapters': path.resolve(__dirname, './src/adapters/index.ts'),
      '#clients': path.resolve(__dirname, './src/clients/index.ts'),
      '#runtime': path.resolve(__dirname, './src/runtime/index.ts'),
      '#test-kit': path.resolve(__dirname, './src/test-kit/index.ts'),
      '#modules': path.resolve(__dirname, './src/modules'),
      '#routes': path.resolve(__dirname, './src/routes'),
    },
  },
  test: {
    globals: true,
    server: {
      deps: {
        inline: ['@meteora-ag/dlmm', '@coral-xyz/anchor'],
      },
    },
  },
})
