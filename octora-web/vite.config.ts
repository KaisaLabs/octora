import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig(({ mode }) => ({
  server: {
    host: "0.0.0.0",
    port: 3000,
    hmr: {
      overlay: false,
    },
    proxy: {
      "/api": {
        target: process.env.VITE_API_URL || "http://localhost:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Browser shims for Node-only modules pulled in transitively by
      // snarkjs / circomlibjs / readable-stream. Without these, Vite leaves
      // them as undefined and the bundles throw "assert is not defined" /
      // "events is not defined" at runtime.
      assert: path.resolve(__dirname, "./src/lib/mixer/shims/assert-shim.ts"),
      events: path.resolve(__dirname, "./src/lib/mixer/shims/events-shim.ts"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
}));
