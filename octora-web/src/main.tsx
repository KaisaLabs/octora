// Browser polyfills for Node globals used by transitive deps (circomlibjs,
// snarkjs, ffjavascript, parts of @solana/web3.js). These MUST run before
// any module that touches `Buffer` or `process` is imported, so they live
// at the top of the entry file ahead of App.
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}
if (typeof globalThis.process === "undefined") {
  (globalThis as unknown as { process: { env: Record<string, string>; version: string } }).process = {
    env: {},
    version: "",
  };
}

import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initObservability } from "./lib/observability";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Initialize Sentry before App mounts so breadcrumbs from app boot are
// captured. No-op when VITE_SENTRY_DSN is unset (dev / local).
initObservability();

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
