import type { FastifyInstance } from "fastify";
import { RelayerAdapter } from "#modules/execution/adapters";
import { createDepositsController } from "./deposits.controller.js";

export interface DepositsRoutesOptions {
  /** Mixer pool denomination in lamports — surfaced on the privacy receipt. */
  mixerDenomination: bigint;
}

/**
 * Deposits routes — entry point for the "Deposit privately" UX.
 *
 * The browser derives its stealth keypair from a wallet signature
 * (octora-web/src/lib/stealthVault.ts) and sends only the pubkey to
 * /deposits/prepare-private. The seed never touches the server.
 *
 * After this call, the browser drives the rest of the lifecycle through
 * the existing /executor/* routes, signing each tx locally with its
 * derived stealth keypair.
 */
export async function registerDepositsRoutes(
  app: FastifyInstance,
  opts: DepositsRoutesOptions,
) {
  const tags = ["Deposits"];

  // The relayer-service-backed exit path isn't wired through this route yet,
  // so the adapter is instantiated without one. prepareFunding only needs
  // the stealth pubkey from the caller.
  const privacy = new RelayerAdapter();
  const controller = createDepositsController(privacy, {
    denominationLamports: opts.mixerDenomination,
  });

  app.post(
    "/deposits/prepare-private",
    { schema: { tags } },
    controller.preparePrivate,
  );
}
