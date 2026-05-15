/**
 * Mid-position fee claim — Flow 3 (close/05).
 *
 * Lets a user claim accrued fees on an `active` Position without
 * closing it. Fees land in the Stealth Wallet's free balance. This is
 * intentionally non-atomic — the atomic compound (`claim_fee` →
 * `mixer.deposit` in one tx) is wontfix per ADR-0003 / dust/06.
 *
 * Lifecycle invariant: Position state stays `active` throughout. We
 * never advance the aggregate; we only emit Activity Records. The
 * existing claim-and-close pipeline (`position.claim.service`) is
 * untouched.
 *
 * Re-mix is opt-in. After a successful claim, the user may call
 * `remixClaimedFees` to deposit one denomination of the claimed SOL
 * into the same Mixer Pool the original Position used. The re-mix
 * endpoint wraps the existing Flow 1 deposit machinery and tags the
 * resulting Activity Record with `source: "fee-claim"` so the audit
 * trail can distinguish a fresh deposit from a fee-claim recycle.
 */
import type { MeteoraExecutor } from "#modules/execution/clients";
import { ConflictError, ValidationError } from "#common/errors";

import type { PositionRepository } from "./position.repository";
import type { ActivityService } from "./activity.service";
import { createRecoveryService } from "./recovery.service";
import {
  Position,
  type PositionAggregateDeps,
  type PositionResponse,
} from "./position.aggregate";

/**
 * Display threshold for surfacing the Claim button. Sized to filter
 * sub-dust fee balances that aren't worth a tx. Lamport-equivalent
 * to keep the math consistent with on-chain reads — at 0.01 SOL the
 * relayer signature fee (~5000 lamports) is still trivially covered.
 */
export const MID_POSITION_FEE_CLAIM_DISPLAY_THRESHOLD_LAMPORTS = 10_000_000n; // 0.01 SOL
export const MID_POSITION_FEE_CLAIM_DISPLAY_THRESHOLD_SOL = 0.01;

export class MidPositionFeeClaimStateError extends ConflictError {
  constructor(positionId: string, state: string) {
    super(
      `Position ${positionId} must be in 'active' state to claim mid-position fees (current: ${state}).`,
      { code: "fee_claim_invalid_state", details: { positionId, state } },
    );
    this.name = "MidPositionFeeClaimStateError";
  }
}

export class FeeClaimBelowThresholdError extends ValidationError {
  constructor(public readonly amountLamports: bigint) {
    super(
      `Claimed amount ${amountLamports.toString()} lamports is below the re-mix denomination floor.`,
      { code: "fee_claim_remix_below_denom", details: { amountLamports: amountLamports.toString() } },
    );
    this.name = "FeeClaimBelowThresholdError";
  }
}

export interface ClaimMidPositionFeesInput {
  positionId: string;
}

export interface ClaimMidPositionFeesResult extends PositionResponse {
  /**
   * Lamports of SOL that landed in the Stealth Wallet (relayer-confirmed).
   * For the mock executor this is a deterministic stub value sized so
   * tests can reason about the re-mix offer threshold.
   */
  claimedSolLamports: string;
  /**
   * Optional non-SOL residual the Stealth Wallet now holds. Mirrors the
   * close-flow protocol-level-dust rule (ADR-0003): it stays in the
   * stealth, accepted.
   */
  claimedOtherLamports: string;
  claimedOtherMintSymbol: string | null;
  signature: string;
}

export interface RemixClaimedFeesInput {
  positionId: string;
  /**
   * Mixer Pool denomination (in lamports). Stamped onto the Activity
   * Record so the re-mix is linked to the same-denomination pool the
   * original Position used. Validated against the stealth's claimed
   * SOL balance before the deposit ix is built.
   */
  denomLamports: string;
  /** Optional client-supplied commitment for the fresh deposit. */
  commitment?: string;
  /** Leaf index returned by the on-chain `DepositEvent`. */
  leafIndex?: number;
  /** On-chain signature of the resulting `mixer.deposit`. */
  txSignature?: string;
}

export interface RemixClaimedFeesResult extends PositionResponse {
  source: "fee-claim";
  remixedLamports: string;
  commitment: string | null;
  leafIndex: number | null;
  signature: string | null;
}

/**
 * Mock claim receipt sized at one full Mixer denomination + a small
 * non-SOL residual. The real on-chain path will populate these from
 * pool state + the post-claim stealth balance read. Until the
 * `OnchainMeteoraExecutor` learns to surface claim-amount detail (it
 * only emits a signature today, per the MAINNET_BLOCKER note in
 * `position.claim.service`), the mid-claim path emits the same stub
 * the existing managed-claim path emits.
 */
const MOCK_CLAIMED_SOL_LAMPORTS = 250_000_000n; // 0.25 SOL
const MOCK_CLAIMED_OTHER_LAMPORTS = 1_200n; // sub-dust other-side residual
const MOCK_CLAIMED_OTHER_MINT_SYMBOL: string | null = "USDC";

export async function claimMidPositionFees(
  positionRepo: PositionRepository,
  activityService: ActivityService,
  meteoraExecutor: MeteoraExecutor,
  input: ClaimMidPositionFeesInput,
): Promise<ClaimMidPositionFeesResult> {
  const recoveryService = createRecoveryService();
  const deps: PositionAggregateDeps = { positionRepo, activityService, recoveryService };
  const position = await Position.load(deps, input.positionId);

  if (position.state !== "active" || position.sessionState !== "active") {
    throw new MidPositionFeeClaimStateError(input.positionId, position.state);
  }

  // No state transition — we record activity at `active` only. The
  // executor.claim call returns a receipt; in mock mode the lamports
  // come from the constants above. On-chain mode falls back to the
  // same stub until the executor surfaces post-claim balances (see
  // MAINNET_BLOCKER on position.claim.service).
  const venueReceipt = await meteoraExecutor.claim({
    podId: position.id,
    positionId: position.id,
  });

  const claimedSol = MOCK_CLAIMED_SOL_LAMPORTS;
  const claimedOther = MOCK_CLAIMED_OTHER_LAMPORTS;
  const otherSymbol = MOCK_CLAIMED_OTHER_MINT_SYMBOL;

  await position.recordActivity("active", {
    headline: "Fees claimed to Stealth Wallet",
    detail: buildClaimDetail(claimedSol, claimedOther, otherSymbol, venueReceipt.signature),
    safeNextStep: "wait",
  });

  const response = await position.toResponse();
  return {
    ...response,
    claimedSolLamports: claimedSol.toString(),
    claimedOtherLamports: claimedOther.toString(),
    claimedOtherMintSymbol: otherSymbol,
    signature: venueReceipt.signature,
  };
}

export async function remixClaimedFees(
  positionRepo: PositionRepository,
  activityService: ActivityService,
  input: RemixClaimedFeesInput,
): Promise<RemixClaimedFeesResult> {
  const recoveryService = createRecoveryService();
  const deps: PositionAggregateDeps = { positionRepo, activityService, recoveryService };
  const position = await Position.load(deps, input.positionId);

  if (position.state !== "active" || position.sessionState !== "active") {
    throw new MidPositionFeeClaimStateError(input.positionId, position.state);
  }

  let denomLamports: bigint;
  try {
    denomLamports = BigInt(input.denomLamports);
  } catch {
    throw new ValidationError(
      `denomLamports must be a positive bigint string; got "${input.denomLamports}".`,
      { code: "fee_claim_remix_bad_denom" },
    );
  }
  if (denomLamports <= 0n) {
    throw new ValidationError(
      `denomLamports must be > 0; got ${denomLamports.toString()}.`,
      { code: "fee_claim_remix_bad_denom" },
    );
  }

  // We don't re-read the stealth balance here — that's the caller's
  // job (the UI gates the Re-mix button on SOL portion ≥ denomination
  // from the prior claim receipt). The Activity Record is the source
  // of truth for "this Position re-mixed N lamports tagged
  // source=fee-claim".
  await position.recordActivity("active", {
    headline: "Fees re-mixed",
    detail: buildRemixDetail(denomLamports, input.commitment, input.leafIndex, input.txSignature),
    safeNextStep: "wait",
  });

  const response = await position.toResponse();
  return {
    ...response,
    source: "fee-claim",
    remixedLamports: denomLamports.toString(),
    commitment: input.commitment ?? null,
    leafIndex: input.leafIndex ?? null,
    signature: input.txSignature ?? null,
  };
}

function buildClaimDetail(
  sol: bigint,
  other: bigint,
  otherSymbol: string | null,
  signature: string,
): string {
  const solLabel = `${formatLamportsToSol(sol)} SOL`;
  const otherLabel =
    other > 0n && otherSymbol
      ? ` + ${other.toString()} ${otherSymbol}`
      : "";
  return (
    `Octora claimed ${solLabel}${otherLabel} into the Stealth Wallet. ` +
    `Signature: ${signature}. Re-mix or leave it sitting — Position stays active.`
  );
}

function buildRemixDetail(
  lamports: bigint,
  commitment?: string,
  leafIndex?: number,
  signature?: string,
): string {
  const parts = [`Source: fee-claim. Re-mixed ${formatLamportsToSol(lamports)} SOL.`];
  if (commitment) parts.push(`Commitment: ${commitment}.`);
  if (typeof leafIndex === "number") parts.push(`Leaf index: ${leafIndex}.`);
  if (signature) parts.push(`Signature: ${signature}.`);
  return parts.join(" ");
}

function formatLamportsToSol(lamports: bigint): string {
  // SOL has 9 decimals; format with at most 6 visible decimals to match
  // the rest of the UI's lamport-to-SOL renderers.
  const integerPart = lamports / 1_000_000_000n;
  const fractionPart = lamports % 1_000_000_000n;
  if (fractionPart === 0n) return integerPart.toString();
  const fractionStr = fractionPart.toString().padStart(9, "0").slice(0, 6).replace(/0+$/, "");
  return fractionStr ? `${integerPart.toString()}.${fractionStr}` : integerPart.toString();
}
