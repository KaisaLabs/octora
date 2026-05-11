import * as Sentry from "@sentry/react";

/**
 * Frontend observability seam.
 *
 * No-op until VITE_SENTRY_DSN is set in the env. That makes local + ci
 * builds free of telemetry; production builds activate by setting the
 * DSN at build time (vite injects import.meta.env.VITE_*).
 *
 * The orchestrators (privateDeposit, privateClaim, privateExit) call
 * `breadcrumb()` at every step so a mid-flow crash arrives with a full
 * trail: derive → relayer-info → mixer-deposit → ... → boom. Without
 * this, all we'd see in Sentry is the React component-tree crash with
 * no flow context.
 */

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const ENV = (import.meta.env.MODE ?? "development") as string;
const RELEASE = import.meta.env.VITE_RELEASE as string | undefined;

let initialized = false;

export function initObservability(): void {
  if (initialized) return;
  initialized = true;
  if (!DSN) {
    // No DSN configured. Sentry's `init` accepts undefined dsn and no-ops,
    // but we short-circuit to keep the SDK fully dormant — no network
    // sniffing for sample rates, no console patches.
    return;
  }
  Sentry.init({
    dsn: DSN,
    environment: ENV,
    release: RELEASE,
    integrations: [Sentry.browserTracingIntegration()],
    // Privacy: 10-tester beta means low volume, prioritize signal over
    // noise. Sample all traces; per-event sampling is the default 1.0.
    tracesSampleRate: 1.0,
    // Don't blanket-mask everything since the breadcrumbs ARE the signal
    // we need to debug flow failures. Sensitive fields (proofs,
    // commitments, secret keys) are filtered explicitly below.
    beforeBreadcrumb(crumb) {
      const data = crumb.data;
      if (data && typeof data === "object") {
        const scrubbed: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
          if (SENSITIVE_KEY_RE.test(k)) continue;
          scrubbed[k] = v;
        }
        return { ...crumb, data: scrubbed };
      }
      return crumb;
    },
  });
}

/**
 * Match anything that smells like secret material. Matches `secret`,
 * `nullifier`, `proof`, `privateKey`, `keypair`, `seed`, `mnemonic` —
 * names the orchestrators may carry through their step data payloads.
 */
const SENSITIVE_KEY_RE = /secret|nullifier|proof|publicSignals|privateKey|keypair|seed|mnemonic/i;

/**
 * Record a flow event without raising. Safe to call before
 * `initObservability` — it queues into Sentry's pre-init buffer.
 */
export function breadcrumb(
  category: string,
  message: string,
  data?: Record<string, unknown>,
  level: Sentry.SeverityLevel = "info",
): void {
  Sentry.addBreadcrumb({
    category,
    message,
    level,
    data,
  });
}

/** Capture an exception for the dashboard. Already attaches breadcrumb trail. */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

export { Sentry };
