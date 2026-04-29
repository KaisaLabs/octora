-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "poolSlug" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionSession" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "failureStage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "safeNextStep" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PositionReconciliation" (
    "positionId" TEXT NOT NULL,
    "signature" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PositionReconciliation_pkey" PRIMARY KEY ("positionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Position_intentId_key" ON "Position"("intentId");

-- CreateIndex
CREATE INDEX "ExecutionSession_positionId_createdAt_idx" ON "ExecutionSession"("positionId", "createdAt");

-- CreateIndex
CREATE INDEX "Activity_positionId_createdAt_idx" ON "Activity"("positionId", "createdAt");

-- AddForeignKey
ALTER TABLE "ExecutionSession" ADD CONSTRAINT "ExecutionSession_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE CASCADE ON UPDATE CASCADE;
