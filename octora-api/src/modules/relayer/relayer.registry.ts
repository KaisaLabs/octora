import type { MixerRelayerConfig } from "#common/config";
import { OnChainNullifierRegistry } from "./nullifier-registry.js";
import { createPrismaRootSeenRepository, type RootSeenRepository } from "./root-seen.repository.js";
import { RelayerService } from "./relayer.service.js";
import { createMixerClient, deriveMixerPoolPDA } from "./solana-client.js";
import type { RelayerConfig } from "./types.js";
import type { RelayerInfoResponse } from "./relayer.controller.js";
import type { PrismaClient } from "@prisma/client";
import {
  UnknownDenominationError,
} from "#modules/mixer/mixer.registry";

export interface RelayerInfoBundle {
  /** Hot wallet pubkey — shared across all denominations. */
  relayerPubkey: string;
  /** Advertised fee — shared across all denominations for the MVP. */
  feeLamports: string;
  /** Back-compat: the default pool's denomination (= the first configured). */
  denominationLamports: string;
  /** Back-compat: the default pool's mixer PDA. */
  mixerPoolAddress: string;
  /** Multi-pool list — new clients pick the entry matching their selection. */
  pools: Array<{ denomination: string; mixerPoolAddress: string }>;
}

interface RelayerEntry {
  service: RelayerService;
  info: RelayerInfoResponse;
}

/**
 * Holds one `RelayerService` per configured pool denomination. All entries
 * share a single hot wallet — that simplifies ops (one balance to monitor,
 * one alarm) and keeps the proof's `relayer` public input stable across
 * denominations. The per-denom segregation we want for MVP is at the pool
 * level (deposits and withdrawals route through the right mixer_pool PDA),
 * not at the signing-key level.
 */
export class RelayerRegistry {
  readonly denominations: readonly bigint[];
  readonly defaultDenomination: bigint;
  readonly infoBundle: RelayerInfoBundle;
  private readonly entries = new Map<string, RelayerEntry>();

  private constructor(
    denominations: bigint[],
    entries: Map<string, RelayerEntry>,
    infoBundle: RelayerInfoBundle,
  ) {
    this.denominations = denominations;
    this.defaultDenomination = denominations[0]!;
    this.entries = entries;
    this.infoBundle = infoBundle;
  }

  static async create(
    cfg: MixerRelayerConfig,
    prisma: PrismaClient | null,
  ): Promise<RelayerRegistry> {
    const denominations = cfg.denominations ?? [cfg.poolDenomination];
    if (denominations.length === 0) {
      throw new Error("RelayerRegistry requires at least one denomination");
    }

    // One root-seen repository instance shared across all denominations —
    // the table is keyed on root hex, which is globally unique regardless
    // of which pool produced it, so a single repo is sufficient and avoids
    // cross-contamination on cluster forks.
    const rootSeenRepo: RootSeenRepository | null = prisma
      ? createPrismaRootSeenRepository(prisma)
      : null;

    const entries = new Map<string, RelayerEntry>();
    let firstPoolAddress = "";
    let firstPubkey = "";

    for (const denomination of denominations) {
      const serviceConfig: RelayerConfig = {
        baseFeelamports: cfg.minFeeLamports,
        minFeeLamports: cfg.minFeeLamports,
        hotWalletSecret: cfg.hotWalletSecret,
        rpcUrl: cfg.rpcUrl,
        mixerProgramId: cfg.mixerProgramId,
        poolDenomination: denomination,
        privacyDelayMs: cfg.privacyDelayMs,
      };

      // Each service constructs its own MixerClient — three connections + three
      // program instances. The hot wallet keypair is the same across all of
      // them (deterministic load from the same secret), so the on-chain
      // signer is identical and the proof's `relayer` public input stays
      // consistent regardless of which denomination the user picked.
      const client = createMixerClient(serviceConfig);
      const [poolPDA] = deriveMixerPoolPDA(client.programId, denomination);
      const nullifiers = new OnChainNullifierRegistry(
        client.provider.connection,
        client.programId,
        poolPDA,
      );

      const service = new RelayerService(serviceConfig, nullifiers, rootSeenRepo);
      service.initializeClient();

      const pubkey = client.hotWallet.publicKey.toBase58();
      if (!firstPubkey) firstPubkey = pubkey;
      if (firstPubkey && firstPubkey !== pubkey) {
        // Defensive — we use the same hotWalletSecret for every entry so the
        // pubkey MUST match. If it ever doesn't, the proof's relayer field
        // would diverge across denominations and silently fail verification.
        throw new Error(
          `RelayerRegistry: hot wallet diverged across denominations (${pubkey} vs ${firstPubkey})`,
        );
      }

      const info: RelayerInfoResponse = {
        relayerPubkey: pubkey,
        feeLamports: cfg.minFeeLamports.toString(),
        denominationLamports: denomination.toString(),
        mixerPoolAddress: poolPDA.toBase58(),
      };

      entries.set(denomination.toString(), { service, info });
      if (!firstPoolAddress) firstPoolAddress = poolPDA.toBase58();
    }

    const infoBundle: RelayerInfoBundle = {
      relayerPubkey: firstPubkey,
      feeLamports: cfg.minFeeLamports.toString(),
      denominationLamports: denominations[0]!.toString(),
      mixerPoolAddress: firstPoolAddress,
      pools: denominations.map((d) => {
        const entry = entries.get(d.toString())!;
        return {
          denomination: d.toString(),
          mixerPoolAddress: entry.info.mixerPoolAddress,
        };
      }),
    };

    return new RelayerRegistry(denominations, entries, infoBundle);
  }

  get(denomination: bigint): RelayerEntry {
    const entry = this.entries.get(denomination.toString());
    if (!entry) {
      throw new UnknownDenominationError(denomination, this.denominations);
    }
    return entry;
  }

  list(): RelayerEntry[] {
    return this.denominations.map((d) => this.entries.get(d.toString())!);
  }
}
