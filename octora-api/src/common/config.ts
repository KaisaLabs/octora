export interface AppConfig {
  port: number;
  databaseUrl: string;
  frontendUrl: string;
  /** When true, the position service uses the on-chain `octora-executor` instead of the mock. */
  useOnchainExecutor: boolean;
  /** Solana RPC the on-chain executor talks to. Only used when `useOnchainExecutor` is true. */
  executorRpcUrl: string;
  /** Program ID of the deployed `octora-executor`. Defaults to the localnet keypair. */
  executorProgramId: string;
  /** Path to the relayer hot wallet keypair JSON. Pays gas for executor txs. */
  executorRelayerKeypairPath: string;
  /** Mixer relayer config — `null` when the relayer is disabled (default). */
  mixerRelayer: MixerRelayerConfig | null;
}

/**
 * Mixer relayer wiring config. Only loaded when `OCTORA_MIXER_RELAYER_ENABLED=true`,
 * because the relayer holds a hot wallet and must NOT be enabled on serverless
 * deploys where filesystem keypairs leak / inline secrets get logged.
 */
export interface MixerRelayerConfig {
  rpcUrl: string;
  mixerProgramId: string;
  /** Pool denomination in lamports — one relayer instance services one pool. */
  poolDenomination: bigint;
  /** Inline JSON byte array OR `file:<absolute-path>` to a 0600 keypair file. */
  hotWalletSecret: string;
  /**
   * Minimum fee the relayer accepts in a withdrawal proof. Tune above the
   * worst-case priority fee + base fee for the target network.
   */
  minFeeLamports: bigint;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 8787),
    databaseUrl: process.env.DATABASE_URL ?? "",
    frontendUrl: process.env.FRONTEND_URL ?? "*",
    useOnchainExecutor: process.env.OCTORA_USE_ONCHAIN_EXECUTOR === "true",
    executorRpcUrl:
      process.env.OCTORA_EXECUTOR_RPC_URL ?? "https://api.devnet.solana.com",
    executorProgramId:
      process.env.OCTORA_EXECUTOR_PROGRAM_ID ??
      "86zj6EvHxMywP4Bw4EyZ2VcAjLm1pfGsc6ZjsZbrWwwc",
    executorRelayerKeypairPath:
      process.env.OCTORA_EXECUTOR_RELAYER_KEYPAIR ??
      `${process.env.HOME ?? ""}/.config/solana/id.json`,
    mixerRelayer: loadMixerRelayerConfig(),
  };
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

  return {
    rpcUrl: required("OCTORA_MIXER_RELAYER_RPC_URL"),
    mixerProgramId: required("OCTORA_MIXER_PROGRAM_ID"),
    poolDenomination: BigInt(required("OCTORA_MIXER_POOL_DENOMINATION")),
    hotWalletSecret: required("OCTORA_MIXER_RELAYER_HOT_WALLET"),
    minFeeLamports: BigInt(required("OCTORA_MIXER_RELAYER_MIN_FEE")),
  };
}
