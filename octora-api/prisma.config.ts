import path from 'node:path'
import "dotenv/config";
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  earlyAccess: true,
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  datasource: {
    url: env("DATABASE_URL"),
  },
  migrate: {
    async development() {
      return {
        url: env("DATABASE_URL"),
      }
    },
  },
})
