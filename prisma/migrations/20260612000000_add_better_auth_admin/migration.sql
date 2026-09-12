-- @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/better-auth@0.3.0. Drift = commit rejected.
-- Forward-only. Adds Better Auth admin plugin fields to existing auth tables.
-- The admin plugin supplies default role behavior in src/lib/auth.ts; database
-- defaults keep fresh SQL inserts and existing rows aligned with that behavior.

-- AlterTable
ALTER TABLE "user" ADD COLUMN "role" TEXT DEFAULT 'user';
ALTER TABLE "user" ADD COLUMN "banned" BOOLEAN DEFAULT false;
ALTER TABLE "user" ADD COLUMN "banReason" TEXT;
ALTER TABLE "user" ADD COLUMN "banExpires" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "session" ADD COLUMN "impersonatedBy" TEXT;
