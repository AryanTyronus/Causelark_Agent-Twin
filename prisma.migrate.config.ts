// Prisma CLI config for the migrate commands.
//
// WHY THIS FILE EXISTS
//
// `prisma.config.ts` sets `schema` to the `prisma/schema` folder. Prisma derives
// the migrations directory from the schema location when no explicit migration
// path is provided. That would make the CLI look under `prisma/schema/migrations/`,
// while this project stores migrations in `prisma/migrations/`.
//
// This config supplies Prisma's supported `migrations.path` override so the
// migration commands use the canonical `prisma/migrations/` directory.
//
// SCOPE: only the migrate commands use this file. `prisma generate`, `db push`
// and `prisma studio` continue using `prisma.config.ts`.
//
// A Prisma config file disables Prisma's automatic `.env` loading, so it is
// restored here for local development.

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
