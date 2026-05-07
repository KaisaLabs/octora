import type { FastifyInstance } from "fastify";
import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { RelayerService } from "./relayer.service.js";
import { OnChainNullifierRegistry } from "./nullifier-registry.js";
import { Connection } from "@solana/web3.js";
import { deriveMixerPoolPDA } from "./solana-client.js";
import {
  createRelayerController,
  type RelayerInfoResponse,
} from "./relayer.controller.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

export interface RelayerRoutesOptions {
  mixerProgramId: string;
  mixerRelayerKeypairPath: string;
  mixerRelayerFeeLamports: bigint;
  mixerDenomination: bigint;
}

/**
 * Mixer relayer routes.
 *
 * Exposes:
 *   GET  /relayer/info     — relayer pubkey + fee + denomination (browser
 *                            needs these to bind into the Groth16 proof)
 *   POST /relayer/withdraw — submit a proven withdrawal; relayer pays gas
 */
export async function registerRelayerRoutes(
  app: FastifyInstance,
  opts: RelayerRoutesOptions,
) {
  const tags = ["Relayer"];

  const hotWalletJson = readFileSync(opts.mixerRelayerKeypairPath, "utf-8");
  const hotWallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(hotWalletJson)));

  const programId = new PublicKey(opts.mixerProgramId);
  const [mixerPoolPDA] = deriveMixerPoolPDA(programId, opts.mixerDenomination);

  const connection = new Connection(RPC_URL, "confirmed");
  const nullifierRegistry = new OnChainNullifierRegistry(
    connection,
    programId,
    mixerPoolPDA,
  );

  const relayer = new RelayerService(
    {
      baseFeelamports: opts.mixerRelayerFeeLamports,
      // RelayerService consumes the keypair via solana-client.loadHotWallet;
      // we hand it the JSON bytes inline so we don't read the file twice.
      hotWalletSecret: hotWalletJson,
      rpcUrl: RPC_URL,
      mixerProgramId: opts.mixerProgramId,
      poolDenomination: opts.mixerDenomination,
    },
    nullifierRegistry,
  );
  relayer.initializeClient();

  const info: RelayerInfoResponse = {
    relayerPubkey: hotWallet.publicKey.toBase58(),
    feeLamports: opts.mixerRelayerFeeLamports.toString(),
    denominationLamports: opts.mixerDenomination.toString(),
    mixerPoolAddress: mixerPoolPDA.toBase58(),
  };

  const controller = createRelayerController(relayer, info);

  app.get("/relayer/info", { schema: { tags } }, controller.getInfo);
  app.post("/relayer/withdraw", { schema: { tags } }, controller.withdraw);
}
