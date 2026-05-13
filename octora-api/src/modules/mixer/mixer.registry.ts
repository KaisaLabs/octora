import { PublicKey } from "@solana/web3.js";
import { ValidationError } from "#common/errors";
import { MixerService } from "./mixer.service.js";

export interface MixerRegistryConfig {
  rpcUrl: string;
  programId: PublicKey;
  denominations: bigint[];
}

/**
 * Holds one `MixerService` instance per configured pool denomination.
 *
 * The on-chain mixer program uses `[b"mixer_pool", denomination.to_le_bytes()]`
 * as the pool PDA seed, so each denomination is a *distinct* pool with its
 * own deposit history, Merkle root, and balance. Each `MixerService` is
 * constructed against one denomination and is therefore single-purpose;
 * the registry routes per-request to the right instance.
 *
 * Routes pass `(denomination?) => registry.get(denomination ?? defaultDenom)`
 * as the resolver to the controller, which means controller methods stay
 * agnostic to whether the deployment is single-denom or multi-denom.
 */
export class MixerRegistry {
  readonly denominations: readonly bigint[];
  readonly defaultDenomination: bigint;
  private readonly services = new Map<string, MixerService>();

  constructor(config: MixerRegistryConfig) {
    if (config.denominations.length === 0) {
      throw new Error("MixerRegistry requires at least one denomination");
    }
    this.denominations = [...config.denominations];
    this.defaultDenomination = config.denominations[0]!;
    for (const denomination of config.denominations) {
      this.services.set(
        denomination.toString(),
        new MixerService({
          rpcUrl: config.rpcUrl,
          denomination,
          programId: config.programId,
        }),
      );
    }
  }

  get(denomination: bigint): MixerService {
    const service = this.services.get(denomination.toString());
    if (!service) {
      throw new UnknownDenominationError(denomination, this.denominations);
    }
    return service;
  }

  list(): { denomination: bigint; service: MixerService }[] {
    return this.denominations.map((denomination) => ({
      denomination,
      service: this.services.get(denomination.toString())!,
    }));
  }
}

export class UnknownDenominationError extends ValidationError {
  constructor(
    public readonly requested: bigint,
    public readonly available: readonly bigint[],
  ) {
    super(
      `denomination ${requested.toString()} is not configured; available: ${available
        .map((d) => d.toString())
        .join(", ")}`,
      {
        code: "unknown_denomination",
        details: {
          requested: requested.toString(),
          available: available.map((d) => d.toString()),
        },
      },
    );
    this.name = "UnknownDenominationError";
  }
}

export type MixerServiceResolver = (denomination?: bigint) => MixerService;

/**
 * Parse a denomination value out of a request payload. Accepts either bigint,
 * number, or numeric string. Returns `null` for missing/empty values so the
 * caller can fall back to the registry's default. Throws on a malformed value
 * so a typo doesn't silently route to the default pool.
 */
export function parseDenomination(raw: unknown): bigint | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw <= 0) {
      throw new InvalidDenominationError(String(raw));
    }
    return BigInt(raw);
  }
  if (typeof raw === "string") {
    try {
      const v = BigInt(raw);
      if (v <= 0n) throw new Error();
      return v;
    } catch {
      throw new InvalidDenominationError(raw);
    }
  }
  throw new InvalidDenominationError(String(raw));
}

export class InvalidDenominationError extends ValidationError {
  constructor(public readonly value: string) {
    super(`denomination must be a positive integer (lamports); got ${JSON.stringify(value)}`, {
      code: "invalid_denomination",
      details: { value },
    });
    this.name = "InvalidDenominationError";
  }
}
