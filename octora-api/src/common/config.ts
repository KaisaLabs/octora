export interface AppConfig {
  port: number;
  databaseUrl: string;
  /**
   * Allowed CORS origins. Comma-separated allowlist parsed from
   * `FRONTEND_URL`. The wildcard `"*"` is permitted only in non-production
   * `NODE_ENV` — production startup throws if `FRONTEND_URL` is unset or
   * `"*"`, since a wildcard fallback lets any origin call the API on behalf
   * of an authenticated browser.
   */
  frontendUrl: string | string[];
  /** When true, the position service uses the on-chain `octora-executor` instead of the mock. */
  useOnchainExecutor: boolean;
  /** Solana RPC the on-chain executor talks to. Only used when `useOnchainExecutor` is true. */
  executorRpcUrl: string;
  /** Program ID of the deployed `octora-executor`. Required (set via OCTORA_EXECUTOR_PROGRAM_ID). */
  executorProgramId: string;
  /** Program ID of the deployed `octora-mixer`. Required (set via OCTORA_MIXER_PROGRAM_ID). */
  mixerProgramId: string;
  /** Path to the relayer hot wallet keypair JSON. Pays gas for executor txs. */
  executorRelayerKeypairPath: string;
  /** Fixed-amount mixer pool denomination in lamports (must match the on-chain pool).
   *
   * Retained for backward-compatibility with single-denomination wiring
   * (relayer, deposits orchestrator, executor receipts). Defaults to the
   * first entry of `mixerDenominations` when not explicitly set.
   */
  mixerDenomination: bigint;
  /** Full set of supported mixer pool denominations in lamports (sorted ascending).
   *
   * Surfaced by `/mixer/pools` so the frontend can render the denomination
   * selector with per-pool anonymity-set badges. The doc spec is
   * `[100_000_000, 1_000_000_000, 10_000_000_000]` (0.1, 1, 10 SOL); override
   * via `MIXER_DENOMINATIONS` env (comma-separated lamports).
   */
  mixerDenominations: bigint[];
  /** Mixer relayer config — `null` when the relayer is disabled (default). */
  mixerRelayer: MixerRelayerConfig | null;
  /**
   * Beta cohort guardrails. All positions are denominated in SOL (decimal
   * string) to match the existing `Position.amount` column. Convert from
   * USD targets via your reference price — defaults assume ~$200/SOL.
   */
  betaCaps: BetaCapsConfig;
  /**
   * Shared-secret token required by the `/admin/*` endpoints. When unset,
   * admin routes refuse every request — same fail-closed posture as the
   * relayer keypair when `OCTORA_MIXER_RELAYER_ENABLED` is missing.
   */
  adminApiToken: string | null;
  /**
   * Sentry DSN. When null, `@sentry/node` is never loaded and capture
   * helpers no-op. Set `SENTRY_DSN` in the environment to activate
   * (requires `pnpm add @sentry/node` first; see common/observability.ts).
   */
  sentryDsn: string | null;
}

export interface BetaCapsConfig {
  /** Max SOL per position (audit target: ~$500 ≈ 2.5 SOL). */
  maxPositionSol: number;
  /** Max active TVL across the protocol (audit target: ~$25k ≈ 125 SOL). */
  maxGlobalTvlSol: number;
  /** Max concurrent active positions per wallet. */
  maxPositionsPerWallet: number;
}

/**
 * Mixer relayer wiring config. Only loaded when `OCTORA_MIXER_RELAYER_ENABLED=true`,
 * because the relayer holds a hot wallet and must NOT be enabled on serverless
 * deploys where filesystem keypairs leak / inline secrets get logged.
 */
export interface MixerRelayerConfig {
  rpcUrl: string;
  mixerProgramId: string;
  /** Default pool denomination in lamports (= first entry of `denominations`). */
  poolDenomination: bigint;
  /**
   * Optional multi-pool list. When set, the relayer registry creates one
   * service per entry, all sharing the same hot wallet. When omitted, the
   * registry falls back to a single-pool relayer using `poolDenomination`,
   * preserving the legacy single-denom config path.
   */
  denominations?: bigint[];
  /** Inline JSON byte array OR `file:<absolute-path>` to a 0600 keypair file. */
  hotWalletSecret: string;
  /**
   * Minimum fee the relayer accepts in a withdrawal proof. Tune above the
   * worst-case priority fee + base fee for the target network.
   */
  minFeeLamports: bigint;
  /**
   * Privacy delay in ms — relayer rejects withdrawals whose Merkle root was
   * first observed less than this long ago. Defaults to 13_000ms (~32 slots).
   * 0 disables (tests, localnet smoke).
   */
  privacyDelayMs: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 8787),
    databaseUrl: process.env.DATABASE_URL ?? "",
    frontendUrl: loadFrontendUrl(),
    useOnchainExecutor: process.env.OCTORA_USE_ONCHAIN_EXECUTOR === "true",
    executorRpcUrl:
      process.env.OCTORA_EXECUTOR_RPC_URL ?? "https://api.devnet.solana.com",
    executorProgramId: requireEnv("OCTORA_EXECUTOR_PROGRAM_ID"),
    mixerProgramId: requireEnv("OCTORA_MIXER_PROGRAM_ID"),
    executorRelayerKeypairPath:
      process.env.OCTORA_EXECUTOR_RELAYER_KEYPAIR ??
      `${process.env.HOME ?? ""}/.config/solana/id.json`,
    mixerDenomination: BigInt(process.env.MIXER_DENOMINATION ?? "1000000000"),
    mixerDenominations: loadMixerDenominations(),
    mixerRelayer: loadMixerRelayerConfig(),
    betaCaps: {
      maxPositionSol: Number(process.env.BETA_MAX_POSITION_SOL ?? "2.5"),
      maxGlobalTvlSol: Number(process.env.BETA_MAX_GLOBAL_TVL_SOL ?? "125"),
      maxPositionsPerWallet: Number(process.env.BETA_MAX_POSITIONS_PER_WALLET ?? "5"),
    },
    adminApiToken: process.env.OCTORA_ADMIN_API_TOKEN?.trim() || null,
    sentryDsn: process.env.SENTRY_DSN?.trim() || null,
  };
}

/**
 * Parse `FRONTEND_URL` into a strict CORS allowlist.
 *
 * Production (`NODE_ENV === "production"`) requires an explicit value and
 * forbids `"*"` — a wildcard fallback would let any origin call the API on
 * behalf of an authenticated browser. Non-production keeps a permissive
 * default so dev / local builds keep working.
 */
function loadFrontendUrl(): string | string[] {
  const raw = process.env.FRONTEND_URL?.trim() ?? "";
  const isProd = process.env.NODE_ENV === "production";

  if (isProd) {
    if (raw === "" || raw === "*") {
      throw new Error(
        "FRONTEND_URL must be set to a strict comma-separated origin allowlist " +
          "in production (wildcard '*' is forbidden).",
      );
    }
  }

  if (raw === "" || raw === "*") return "*";

  const origins = raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return origins.length === 1 ? origins[0]! : origins;
}

/**
 * Parse `MIXER_DENOMINATIONS` into a sorted, deduplicated bigint list.
 *
 * Defaults to the doc spec (0.1, 1, 10 SOL) when unset so a fresh dev env
 * picks up the multi-pool config without explicit wiring. Throws if any
 * entry isn't a positive integer literal — silently coercing strings would
 * make a typo land as a single-denom config without obvious failure.
 */
function loadMixerDenominations(): bigint[] {
  const raw = process.env.MIXER_DENOMINATIONS?.trim();
  if (!raw) {
    return [100_000_000n, 1_000_000_000n, 10_000_000_000n];
  }
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      let v: bigint;
      try {
        v = BigInt(s);
      } catch {
        throw new Error(
          `MIXER_DENOMINATIONS contains a non-integer entry: ${JSON.stringify(s)}`,
        );
      }
      if (v <= 0n) {
        throw new Error(
          `MIXER_DENOMINATIONS entries must be > 0 lamports; got ${v.toString()}`,
        );
      }
      return v;
    });
  if (parsed.length === 0) {
    throw new Error("MIXER_DENOMINATIONS parsed to an empty list — set or unset the env var.");
  }
  // Dedup + sort ascending so the UI picks a stable order regardless of env.
  const seen = new Set<string>();
  const unique = parsed.filter((d) => {
    const k = d.toString();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return unique;
}

function loadMixerRelayerConfig(): MixerRelayerConfig | null {
  if (process.env.OCTORA_MIXER_RELAYER_ENABLED !== "true") return null;

  const required = (key: string): string => {
    const v = process.env[key];
    if (!v) {
      throw new Error(
        `OCTORA_MIXER_RELAYER_ENABLED=true but ${key} is unset.`,
      );
    }
    return v;
  };

  // Multi-denom config: OCTORA_MIXER_RELAYER_DENOMINATIONS overrides if set,
  // otherwise fall back to the single OCTORA_MIXER_POOL_DENOMINATION list.
  const denomEnv = process.env.OCTORA_MIXER_RELAYER_DENOMINATIONS?.trim();
  const denominations: bigint[] | undefined = denomEnv
    ? denomEnv
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => {
          const v = BigInt(s);
          if (v <= 0n) {
            throw new Error(
              `OCTORA_MIXER_RELAYER_DENOMINATIONS entries must be > 0; got ${v.toString()}`,
            );
          }
          return v;
        })
    : undefined;
  const poolDenomination = BigInt(required("OCTORA_MIXER_POOL_DENOMINATION"));

  return {
    rpcUrl: required("OCTORA_MIXER_RELAYER_RPC_URL"),
    mixerProgramId: required("OCTORA_MIXER_PROGRAM_ID"),
    poolDenomination,
    denominations:
      denominations && denominations.length > 0 ? denominations : undefined,
    hotWalletSecret: required("OCTORA_MIXER_RELAYER_HOT_WALLET"),
    minFeeLamports: BigInt(required("OCTORA_MIXER_RELAYER_MIN_FEE")),
    privacyDelayMs: Number(process.env.OCTORA_MIXER_PRIVACY_DELAY_MS ?? "13000"),
  };
}
