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

createRoot(document.getElementById("root")!).render(<App />);
