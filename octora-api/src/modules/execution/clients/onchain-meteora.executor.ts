import type {
  AddLiquidityInput,
  ClaimInput,
  MeteoraExecutionReceipt,
  MeteoraExecutor,
  WithdrawCloseInput,
} from "./meteora-executor.js";
import type { OctoraExecutorClient } from "./octora-executor.client.js";

/**
 * Bridges the existing `MeteoraExecutor` interface to the on-chain
 * `octora-executor` program.
 *
 * Why the bridge currently throws on every method:
 *   The `MeteoraExecutor` interface only carries `podId`, `positionId`,
 *   and `amountSol` — none of the rich state the on-chain executor
 *   needs (LB pair pubkey, position keypair, stealth keypair, DLMM bin
 *   arrays, exit_recipient, etc.). Wiring the on-chain calls in for real
 *   is Phase 4 of the executor rollout: the position repository must
 *   start storing per-position DLMM context, and the position-service
 *   needs a session-scoped accessor for the (encrypted) stealth keypair
 *   to sign the outer ix.
 *
 *   Until then, enabling `OCTORA_USE_ONCHAIN_EXECUTOR=true` flips the
 *   adapter to this class and any LP-side method call surfaces a clear
 *   error rather than silently returning a fake receipt — useful in
 *   staging to make sure no caller is depending on mock behaviour.
 */
export class OnchainMeteoraExecutor implements MeteoraExecutor {
  constructor(private readonly client: OctoraExecutorClient) {}

  async addLiquidity(input: AddLiquidityInput): Promise<MeteoraExecutionReceipt> {
    throw new OnchainExecutorNotWiredError("addLiquidity", input.podId);
  }

  async claim(input: ClaimInput): Promise<MeteoraExecutionReceipt> {
    throw new OnchainExecutorNotWiredError("claim", input.podId);
  }

  async withdrawClose(input: WithdrawCloseInput): Promise<MeteoraExecutionReceipt> {
    throw new OnchainExecutorNotWiredError("withdrawClose", input.podId);
  }

  /** Underlying low-level client. Use this directly until the bridge is fleshed out. */
  get raw(): OctoraExecutorClient {
    return this.client;
  }
}

export class OnchainExecutorNotWiredError extends Error {
  constructor(method: string, podId: string) {
    super(
      `OnchainMeteoraExecutor.${method} is not wired yet (pod=${podId}). ` +
        `The on-chain executor needs LB pair + position keypair + stealth signer ` +
        `that the position service does not currently surface. Use the low-level ` +
        `OctoraExecutorClient builders for tests, or wait for Phase 4 plumbing.`,
    );
    this.name = "OnchainExecutorNotWiredError";
  }
}

export function createOnchainMeteoraExecutor(
  client: OctoraExecutorClient,
): MeteoraExecutor {
  return new OnchainMeteoraExecutor(client);
}
