/**
 * Anonymity-set policy: the minimum number of *unspent* deposits a
 * mixer pool must hold before any new withdrawal build is accepted,
 * and the typed error surfaced when a withdrawal is rejected for
 * falling under that floor.
 *
 * Lives outside `mixer.service.ts` because both the mixer routes and
 * the relayer routes import `AnonymitySetTooThinError` to map it to an
 * HTTP 400. Keeping it on a sibling-feature class forced the relayer
 * to do a sideways import — exactly the coupling the architecture
 * review flagged for inversion (step 7b of opportunity #1).
 */
import { ApiError } from "#common/errors";
import { loadConfig } from "#common/config";

/**
 * Minimum anonymity set required to permit a withdrawal build.
 *
 * The anonymity set is `next_leaf_index - withdrawals_so_far` — the count
 * of *unspent* deposits in the pool, which is the upper bound on how many
 * leaves a chain observer could plausibly link to any given withdrawal.
 *
 * Twenty is the smallest set where naive intersection attacks (overlap the
 * deposits set with a candidate stealth wallet's known link set) stop being
 * trivially decisive — Tornado Cash's empirical analysis showed sharp
 * de-anonymization risk under ~10 and acceptable mixing above ~20.
 *
 * Override via `MIXER_MIN_ANONYMITY_SET` env for staging/dev where you
 * need to test the withdraw path before twenty real deposits have landed.
 */
export const MIN_ANONYMITY_SET = loadConfig().mixer.minAnonymitySet;

/**
 * Thrown when a withdrawal build is rejected because the target pool has
 * fewer unspent deposits than `MIN_ANONYMITY_SET`. Surfaced by mixer +
 * relayer controllers as HTTP 400 `ANONYMITY_SET_TOO_THIN`.
 */
export class AnonymitySetTooThinError extends ApiError {
  // Keep HTTP 400 + literal `code` to match the legacy frontend contract.
  // The bespoke handlers in mixer.controller.ts / relayer.routes.ts still
  // map this to a route-specific body shape; the new global handler will
  // emit `{ error: { code, message, details } }` if those handlers are
  // ever removed.
  declare readonly code: "ANONYMITY_SET_TOO_THIN";
  constructor(
    readonly current: number,
    readonly required: number,
    readonly denomination: bigint,
  ) {
    super(
      400,
      "ANONYMITY_SET_TOO_THIN",
      `Anonymity set too thin: pool has ${current} unspent deposit(s), required ${required}.`,
      { details: { current, required, denomination: denomination.toString() } },
    );
    this.name = "AnonymitySetTooThinError";
  }
}
