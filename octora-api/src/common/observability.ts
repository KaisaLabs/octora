import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyServerOptions } from "fastify";

import { loadConfig } from "./config/index.js";

/**
 * Observability wiring for octora-api (P1-30).
 *
 * Two pieces:
 *
 *   1. **Pino logger options** — JSON output, ISO timestamps, request-ID
 *      propagation, and `redact` rules that strip the audit's listed
 *      sensitive fields (signedMessage, signature headers, full
 *      Authorization tokens) before they ever hit stdout.
 *
 *   2. **Sentry seam** — `@sentry/node` is loaded only when `SENTRY_DSN`
 *      is set in the environment. We use a dynamic import so the package
 *      is optional: operators activate by `pnpm add @sentry/node` and
 *      setting the DSN. When unloaded, `captureException` is a no-op so
 *      callers don't have to care which mode they're running in.
 */

export interface ObservabilityOptions {
  sentryDsn: string | null;
}

/** Called from the global error handler / catch sites; safe to invoke at startup. */
export type CaptureException = (
  err: unknown,
  context?: Record<string, unknown>,
) => void;

/**
 * Pino options for `Fastify({ logger })`. Configures JSON output + ISO
 * timestamps + request-id propagation + redaction of sensitive fields.
 *
 * The `genReqId` callback honors the `x-request-id` header so a request
 * traced across services keeps the same id; falls back to a fresh UUID.
 */
export function buildLoggerOptions(): FastifyServerOptions["logger"] {
  return {
    level: loadConfig().logLevel,
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    redact: {
      // Pino's redact runs before the line is serialized. We strip:
      //  - any `signature` / `signedMessage` field anywhere in the log object
      //  - the `Authorization` request header (don't even log "Bearer ...")
      //  - the `x-signed-nonce` and `x-signature` headers from auth.ts
      //  - full nullifier hashes (truncated by application-level loggers)
      paths: [
        "signedMessage",
        "*.signedMessage",
        "signature",
        "*.signature",
        "headers.authorization",
        "req.headers.authorization",
        "headers['x-signature']",
        "req.headers['x-signature']",
        "headers['x-signed-nonce']",
        "req.headers['x-signed-nonce']",
        "headers['x-wallet-address']",
        "req.headers['x-wallet-address']",
      ],
      remove: false,
      censor: "[redacted]",
    },
  };
}

/**
 * `genReqId` for `Fastify({ genReqId })`. Honors `x-request-id` from
 * the client (so traces survive an upstream gateway) and falls back
 * to a fresh UUID otherwise.
 */
export function genReqId(req: { headers: Record<string, unknown> }): string {
  const incoming = req.headers["x-request-id"];
  if (typeof incoming === "string" && incoming.trim().length > 0) {
    return incoming.trim();
  }
  return randomUUID();
}

/**
 * Wire the Fastify error handler to forward 5xx errors to Sentry (when
 * configured). Safe to call before / after `setErrorHandler` from the
 * caller — this hooks `onError` rather than replacing the handler.
 */
export async function initSentry(
  app: FastifyInstance,
  opts: ObservabilityOptions,
): Promise<CaptureException> {
  if (!opts.sentryDsn) {
    app.log.info("observability: SENTRY_DSN unset, error capture disabled");
    return () => {};
  }

  // Dynamic import so `@sentry/node` is genuinely optional. We use a
  // bare `any`-typed handle because the package isn't a workspace dep —
  // operators activate by `pnpm add @sentry/node` and setting the DSN.
  // When missing, we log a warning and fall back to no-op capture.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Sentry: any = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Sentry = await (Function("m", "return import(m)") as (m: string) => Promise<any>)(
      "@sentry/node",
    );
  } catch {
    app.log.warn(
      "observability: SENTRY_DSN is set but @sentry/node is not installed. " +
        "Run `pnpm add @sentry/node` to activate; capture is no-op until then.",
    );
    return () => {};
  }

  Sentry.init({
    dsn: opts.sentryDsn,
    environment: loadConfig().nodeEnv,
    tracesSampleRate: 0.1,
  });

  app.addHook("onError", async (req, _reply, err) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Sentry.withScope((scope: any) => {
      scope.setTag("route", req.routeOptions.url ?? req.url);
      scope.setExtra("requestId", req.id);
      scope.setExtra("method", req.method);
      Sentry.captureException(err);
    });
  });

  app.log.info({ sentry: "on" }, "observability: Sentry initialized");
  return (err, ctx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Sentry.withScope((scope: any) => {
      if (ctx) for (const [k, v] of Object.entries(ctx)) scope.setExtra(k, v);
      Sentry.captureException(err);
    });
  };
}

export interface TelemetryOptions {
  /** OTLP/HTTP traces endpoint, e.g. `http://localhost:4318/v1/traces`. */
  endpoint: string | null;
  /** Service name attached to every span. */
  serviceName: string;
}

/**
 * OpenTelemetry trace seam. Same dynamic-import pattern as Sentry: the
 * SDK packages are optional dependencies, so we only require them when
 * an operator opts in via `OTEL_EXPORTER_OTLP_ENDPOINT`.
 *
 * Activation:
 *   pnpm add @opentelemetry/sdk-node @opentelemetry/api \
 *           @opentelemetry/auto-instrumentations-node \
 *           @opentelemetry/exporter-trace-otlp-http
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
 *
 * Returns a shutdown function bound to the SDK's `shutdown()`. The
 * caller wires it into `app.addHook('onClose', shutdown)` so the
 * exporter flushes on graceful stop.
 */
export async function initTelemetry(
  app: FastifyInstance,
  opts: TelemetryOptions,
): Promise<() => Promise<void>> {
  if (!opts.endpoint) {
    app.log.info("observability: OTEL_EXPORTER_OTLP_ENDPOINT unset, tracing disabled");
    return async () => {};
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dyn = Function("m", "return import(m)") as (m: string) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdkPkg: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exporterPkg: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let autoPkg: any;
  try {
    [sdkPkg, exporterPkg, autoPkg] = await Promise.all([
      dyn("@opentelemetry/sdk-node"),
      dyn("@opentelemetry/exporter-trace-otlp-http"),
      dyn("@opentelemetry/auto-instrumentations-node"),
    ]);
  } catch {
    app.log.warn(
      "observability: OTEL_EXPORTER_OTLP_ENDPOINT is set but the OpenTelemetry packages are not installed. " +
        "Run `pnpm add @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http " +
        "@opentelemetry/auto-instrumentations-node` to activate; tracing is no-op until then.",
    );
    return async () => {};
  }

  const sdk = new sdkPkg.NodeSDK({
    serviceName: opts.serviceName,
    traceExporter: new exporterPkg.OTLPTraceExporter({ url: opts.endpoint }),
    instrumentations: [autoPkg.getNodeAutoInstrumentations()],
  });
  // `start()` can throw synchronously if a peer dep is missing.
  // Catch + downgrade so a misconfigured trace pipeline never blocks boot.
  try {
    sdk.start();
  } catch (err) {
    app.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "observability: OpenTelemetry SDK failed to start; tracing disabled",
    );
    return async () => {};
  }

  app.log.info(
    { otel: "on", endpoint: opts.endpoint, service: opts.serviceName },
    "observability: OpenTelemetry initialized",
  );

  return async () => {
    try {
      await sdk.shutdown();
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "observability: OpenTelemetry shutdown raised",
      );
    }
  };
}
