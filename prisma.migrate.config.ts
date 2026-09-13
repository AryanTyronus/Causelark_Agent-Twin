// @polsia:user-owned — Prisma CLI config for the migrate commands.
//
// WHY THIS FILE EXISTS
//
// `prisma.config.ts` is framework-owned ("DO NOT EDIT … Drift = commit rejected"),
// and it sets `schema` to the `prisma/schema` folder. Prisma derives the migrations
// directory from the schema location:
//
//     migrationsDirPath = config.migrations.path ?? path.join(schemaRootDir, 'migrations')
//     (see `ta()` in the Prisma CLI, @prisma/config MigrationsConfigShape)
//
// With `schema: prisma/schema` and no `migrations.path`, the CLI therefore looked in
// `prisma/schema/migrations/` — a directory that does not exist — while every
// migration actually lives in `prisma/migrations/`. The result was a silent no-op:
//
//     $ npm run db:migrate:deploy
//     No migration found in prisma/migrations
//     No pending migrations to apply.        (exit 0, zero migrations applied)
//
// The framework's own ownership map names `prisma/migrations/` as the canonical
// location — "Modules add only their `prisma/migrations/<timestamp>_<name>/` dirs"
// (see .polsia/ownership.json) — so the migrations are already where they belong.
// What was wrong is only the path the CLI was told to look in.
//
// THE FIX
//
// `migrations.path` is Prisma's supported override for exactly this. This file
// supplies it, and the two migrate scripts in package.json pass it via the
// supported `--config` flag (`Custom path to your Prisma config file`). Nothing
// framework-owned is edited and no existing migration is moved or rewritten.
//
// SCOPE: only the migrate commands use this file. `prisma generate`, `db push` and
// `prisma studio` do not read the migrations directory, so they keep using the
// default `prisma.config.ts` and resolve the schema exactly as before.

// A Prisma config file disables Prisma's automatic `.env` loading, so it is
// restored here — the same thing `prisma.config.ts` does. In a Polsia deploy
// DATABASE_URL is injected as a real env var and this import is a no-op.
import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  // Same schema location as the framework config: a folder recursively searched
  // for *.prisma files (datasource + generator in _base.prisma, plus each data
  // module's own file such as simulation.prisma and auth.prisma).
  schema: path.join('prisma', 'schema'),
  migrations: {
    // Where the migrate commands store AND look for migrations. Relative to the
    // project root, like `schema` above, so it resolves the same way `npm run`
    // invokes these scripts.
    path: path.join('prisma', 'migrations'),
  },
});
