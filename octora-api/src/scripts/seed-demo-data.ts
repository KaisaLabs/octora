import { PrismaClient } from "@prisma/client";

const client = new PrismaClient();

const demoPositions = [
  {
    id: "demo-active-position",
    intentId: "demo-intent-active",
    action: "add-liquidity",
    mode: "fast-private",
    state: "active",
    poolSlug: "sol-usdc",
    amount: "1.25",
    session: {
      id: "demo-session-active",
      state: "active",
      failureStage: null,
    },
    activities: [
      {
        id: "demo-active-intent-received",
        action: "add-liquidity",
        state: "awaiting_signature",
        headline: "Intent received",
        detail: "Queued a Fast Private SOL / USDC position for signature review.",
        safeNextStep: "wait",
      },
      {
        id: "demo-active-position-live",
        action: "add-liquidity",
        state: "active",
        headline: "Position active",
        detail: "The final snapshot is available and the position is now live.",
        safeNextStep: "wait",
      },
    ],
  },
  {
    id: "demo-recovery-position",
    intentId: "demo-intent-recovery",
    action: "add-liquidity",
    mode: "fast-private",
    state: "indexing",
    poolSlug: "sol-usdc",
    amount: "2.50",
    session: {
      id: "demo-session-recovery",
      state: "indexing",
      failureStage: null,
    },
    activities: [
      {
        id: "demo-recovery-intent-received",
        action: "add-liquidity",
        state: "awaiting_signature",
        headline: "Intent received",
        detail: "Queued a Fast Private SOL / USDC position for signature review.",
        safeNextStep: "wait",
      },
      {
        id: "demo-recovery-execution-delayed",
        action: "add-liquidity",
        state: "indexing",
        headline: "Execution delayed",
        detail: "The venue finished, but the final snapshot has not landed yet. Refresh this view in a moment.",
        safeNextStep: "refresh",
      },
    ],
  },
] as const;

async function main() {
  await client.activity.deleteMany({
    where: {
      positionId: {
        in: demoPositions.map((position) => position.id),
      },
    },
  });

  await client.executionSession.deleteMany({
    where: {
      positionId: {
        in: demoPositions.map((position) => position.id),
      },
    },
  });

  await client.position.deleteMany({
    where: {
      id: {
        in: demoPositions.map((position) => position.id),
      },
    },
  });

  for (const position of demoPositions) {
    await client.position.create({
      data: {
        id: position.id,
        intentId: position.intentId,
        action: position.action,
        mode: position.mode,
        state: position.state,
        poolSlug: position.poolSlug,
        amount: position.amount,
        sessions: {
          create: {
            id: position.session.id,
            state: position.session.state,
            failureStage: position.session.failureStage,
          },
        },
        activities: {
          create: position.activities.map((activity) => ({
            id: activity.id,
            action: activity.action,
            state: activity.state,
            headline: activity.headline,
            detail: activity.detail,
            safeNextStep: activity.safeNextStep,
          })),
        },
      },
    });
  }

  console.log(`Seeded ${demoPositions.length} demo positions.`);
  for (const position of demoPositions) {
    console.log(`- ${position.id} (${position.state})`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.$disconnect();
  });
