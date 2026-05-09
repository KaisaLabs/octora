import type { PrismaClient } from "@prisma/client";

/**
 * Persistent privacy-delay tracker for the mixer relayer.
 *
 * The relayer rejects withdrawal proofs whose Merkle root has been
 * observed for less than `privacyDelayMs`. Storing first-seen state in
 * Postgres (instead of an in-memory `Map`) means a relayer restart cannot
 * be used to bypass the timing-correlation defense — that's the P0-15
 * audit finding.
 *
 * Slot height is the authoritative gate (monotonic across the cluster);
 * the wall-clock `firstSeenAt` is kept only for diagnostics.
 */
export interface RootSeenRepository {
  /**
   * Idempotent first-seen record. Returns the existing row if the root has
   * been seen before, or inserts a new row at `currentSlot`.
   *
   * Concurrent calls race-safely: one wins the insert, the others read the
   * winner's row. Implementation uses Prisma's `upsert` + `update where`
   * tricks to keep the existing slot when a row already exists.
   */
  observe(root: string, currentSlot: bigint): Promise<{ firstSeenSlot: bigint }>;

  /** Pure read — null when the root has never been observed. */
  get(root: string): Promise<{ firstSeenSlot: bigint } | null>;
}

export function createPrismaRootSeenRepository(prisma: PrismaClient): RootSeenRepository {
  return {
    async observe(root, currentSlot) {
      // Try to insert. If a row already exists, leave its `firstSeenSlot`
      // alone (the earlier slot is the one we want to gate against).
      const row = await prisma.mixerRootSeen.upsert({
        where: { root },
        update: {},
        create: { root, firstSeenSlot: currentSlot },
        select: { firstSeenSlot: true },
      });
      return { firstSeenSlot: row.firstSeenSlot };
    },
    async get(root) {
      const row = await prisma.mixerRootSeen.findUnique({
        where: { root },
        select: { firstSeenSlot: true },
      });
      return row ?? null;
    },
  };
}
