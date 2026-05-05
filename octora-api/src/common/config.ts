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
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 8787),
    databaseUrl: process.env.DATABASE_URL ?? "",
    frontendUrl: process.env.FRONTEND_URL ?? "*",
    useOnchainExecutor: process.env.OCTORA_USE_ONCHAIN_EXECUTOR === "true",
    executorRpcUrl: process.env.OCTORA_EXECUTOR_RPC_URL ?? "http://127.0.0.1:8899",
    executorProgramId:
      process.env.OCTORA_EXECUTOR_PROGRAM_ID ??
      "86zj6EvHxMywP4Bw4EyZ2VcAjLm1pfGsc6ZjsZbrWwwc",
    executorRelayerKeypairPath:
      process.env.OCTORA_EXECUTOR_RELAYER_KEYPAIR ??
      `${process.env.HOME ?? ""}/.config/solana/id.json`,
  };
}
