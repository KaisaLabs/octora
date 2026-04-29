import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@octora/domain": path.resolve(__dirname, "../../packages/domain/src/index.ts"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [],
  },
});
