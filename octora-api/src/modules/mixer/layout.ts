/**
 * On-chain `MixerPool` account byte layout, mirrored from
 * `programs/octora-mixer/src/state.rs::MixerPool` and
 * `programs/octora-mixer/src/constants.rs`.
 *
 * Keep these constants in lockstep with the program. Any drift will silently
 * misread `is_paused` and `next_leaf_index`, which the API uses both for
 * `/health` (mainnet-blocker check) and `/metrics` (operator dashboard).
 */

/** Matches `constants.rs::ROOT_HISTORY_SIZE`. */
export const MIXER_POOL_ROOT_HISTORY_SIZE = 256;

/** Matches `constants.rs::TREE_LEVELS`. */
export const MIXER_POOL_TREE_LEVELS = 20;

const DISCRIMINATOR = 8;
const AUTHORITY = 32;
const DENOMINATION = 8;
const NEXT_LEAF_INDEX = 4;
const CURRENT_ROOT_INDEX = 1;

/** Byte offset of `next_leaf_index` inside a `MixerPool` account. */
export const MIXER_POOL_NEXT_LEAF_INDEX_OFFSET =
  DISCRIMINATOR + AUTHORITY + DENOMINATION;

/** Byte offset of `is_paused` inside a `MixerPool` account. */
export const MIXER_POOL_IS_PAUSED_OFFSET =
  DISCRIMINATOR +
  AUTHORITY +
  DENOMINATION +
  NEXT_LEAF_INDEX +
  CURRENT_ROOT_INDEX +
  32 * MIXER_POOL_ROOT_HISTORY_SIZE +
  32 * MIXER_POOL_TREE_LEVELS;
