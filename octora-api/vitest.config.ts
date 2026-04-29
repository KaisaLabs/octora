import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: [
      { find: '#app', replacement: path.resolve(__dirname, './src/app.ts') },
      { find: /^#common\/(.*)/, replacement: path.resolve(__dirname, './src/common/$1') },
      { find: '#domain', replacement: path.resolve(__dirname, './src/domain/index.ts') },
      { find: /^#domain\/(.*)/, replacement: path.resolve(__dirname, './src/domain/$1') },
      { find: /^#modules\/(.*)/, replacement: path.resolve(__dirname, './src/modules/$1') },
      { find: /^#infra\/(.*)/, replacement: path.resolve(__dirname, './src/infra/$1') },
      { find: /^#test-kit\/(.*)/, replacement: path.resolve(__dirname, './src/test-kit/$1') },
      { find: '#test-kit', replacement: path.resolve(__dirname, './src/test-kit/index.ts') },
    ],
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
