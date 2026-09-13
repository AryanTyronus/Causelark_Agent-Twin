// Prisma config: points the CLI at the `prisma/schema/` folder. Replaces the
// deprecated `package.json#prisma` key (which Prisma 7 removes), so
// `prisma generate` / `db push` / `migrate` keep finding the schema. The
// datasource + generator (prisma/schema/_base.prisma) and each data module's
// `prisma/schema/<module>.prisma` live in that folder.
//
// A Prisma config file disables Prisma's automatic `.env` loading, so we restore
// it for local dev (`db:migrate:dev` reads `DATABASE_URL` from `.env`).
import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: path.join('prisma', 'schema'),
});
