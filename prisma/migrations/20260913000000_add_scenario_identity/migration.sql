-- @polsia:user-owned — Agent Twin scenario identity.
-- Forward-only and purely additive: two nullable columns on SimulationRun, no
-- DROP, no ALTER of an existing column, no backfill, no data migration.
--
-- Existing runs keep NULL in both columns and are read exactly as before. A run
-- created under a scenario records the scenario id and the definition version it
-- was built from, so a later replay or evaluation can name the exact definition
-- that shaped it instead of resolving whatever the catalogue holds at read time.
-- The perturbed world itself is not duplicated here: it is already the run's
-- `state` and `initialState`.

-- AlterTable
ALTER TABLE "SimulationRun" ADD COLUMN "scenarioId" TEXT;
ALTER TABLE "SimulationRun" ADD COLUMN "scenarioVersion" INTEGER;
