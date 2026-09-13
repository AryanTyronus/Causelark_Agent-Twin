-- Forward-only. Adds the four simulation tables the Agent Twin runtime reads and
-- writes: SimulationRun (one episode), SimulationAction (one validated or
-- rejected transition), SimulationEvent (the ordered observable timeline), and
-- SimulationToolCall (one allow-listed tool invocation).
--
-- Mirrors prisma/schema/simulation.prisma exactly. The auth tables and
-- migration_lock.toml are framework-owned by the better-auth module and are not
-- touched here. Purely additive: no DROP, no ALTER, no data migration.

-- CreateTable
CREATE TABLE "SimulationRun" (
    "id"                TEXT NOT NULL,
    "ownerId"           TEXT NOT NULL,
    "environmentKey"    TEXT NOT NULL,
    "objectiveKey"      TEXT NOT NULL,
    "seed"              INTEGER NOT NULL,
    "status"            TEXT NOT NULL,
    "agentStatus"       TEXT NOT NULL DEFAULT 'READY',
    "step"              INTEGER NOT NULL DEFAULT 0,
    "state"             JSONB NOT NULL,
    "initialState"      JSONB,
    "configuration"     JSONB,
    "tasks"             JSONB,
    "constraints"       JSONB,
    "budgetLimit"       INTEGER NOT NULL DEFAULT 24,
    "budgetUsed"        INTEGER NOT NULL DEFAULT 0,
    "maxTurns"          INTEGER NOT NULL DEFAULT 12,
    "turnInProgress"    BOOLEAN NOT NULL DEFAULT false,
    "turnCount"         INTEGER NOT NULL DEFAULT 0,
    "terminationReason" TEXT,
    "failureDetails"    TEXT,
    "terminalAt"        TIMESTAMP(3),
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SimulationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimulationAction" (
    "id"              TEXT NOT NULL,
    "runId"           TEXT NOT NULL,
    "step"            INTEGER NOT NULL,
    "actionType"      TEXT NOT NULL,
    "input"           JSONB NOT NULL,
    "accepted"        BOOLEAN NOT NULL,
    "source"          TEXT NOT NULL DEFAULT 'manual',
    "rejectionReason" TEXT,
    "observation"     JSONB NOT NULL,
    "stateDiff"       JSONB,
    "validationCode"  TEXT,
    "resultingState"  JSONB NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimulationAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimulationEvent" (
    "id"        TEXT NOT NULL,
    "runId"     TEXT NOT NULL,
    "sequence"  INTEGER NOT NULL,
    "step"      INTEGER NOT NULL,
    "kind"      TEXT NOT NULL,
    "source"    TEXT NOT NULL,
    "summary"   TEXT NOT NULL,
    "payload"   JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimulationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimulationToolCall" (
    "id"               TEXT NOT NULL,
    "runId"            TEXT NOT NULL,
    "step"             INTEGER NOT NULL,
    "toolName"         TEXT NOT NULL,
    "input"            JSONB NOT NULL,
    "output"           JSONB,
    "status"           TEXT NOT NULL,
    "validationReason" TEXT,
    "latencyMs"        INTEGER,
    "providerMetadata" JSONB,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimulationToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SimulationRun_ownerId_createdAt_idx" ON "SimulationRun"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "SimulationRun_createdAt_idx" ON "SimulationRun"("createdAt");

-- CreateIndex
CREATE INDEX "SimulationAction_runId_createdAt_idx" ON "SimulationAction"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "SimulationAction_runId_step_idx" ON "SimulationAction"("runId", "step");

-- CreateIndex
CREATE INDEX "SimulationEvent_runId_sequence_idx" ON "SimulationEvent"("runId", "sequence");

-- CreateIndex
CREATE INDEX "SimulationEvent_runId_createdAt_idx" ON "SimulationEvent"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "SimulationToolCall_runId_createdAt_idx" ON "SimulationToolCall"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "SimulationToolCall_runId_step_idx" ON "SimulationToolCall"("runId", "step");

-- AddForeignKey
ALTER TABLE "SimulationAction" ADD CONSTRAINT "SimulationAction_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SimulationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimulationEvent" ADD CONSTRAINT "SimulationEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SimulationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimulationToolCall" ADD CONSTRAINT "SimulationToolCall_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SimulationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
