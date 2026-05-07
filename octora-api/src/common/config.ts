export interface AppConfig {
  port: number;
  databaseUrl: string;
  frontendUrl: string;
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
    frontendUrl: process.env.FRONTEND_URL ?? "*",
    useOnchainExecutor: process.env.OCTORA_USE_ONCHAIN_EXECUTOR === "true",
    executorRpcUrl:
      process.env.OCTORA_EXECUTOR_RPC_URL ?? "https://api.devnet.solana.com",
    executorProgramId: requireEnv("OCTORA_EXECUTOR_PROGRAM_ID"),
    mixerProgramId: requireEnv("OCTORA_MIXER_PROGRAM_ID"),
    executorRelayerKeypairPath:
      process.env.OCTORA_EXECUTOR_RELAYER_KEYPAIR ??
      `${process.env.HOME ?? ""}/.config/solana/id.json`,
  };
}
