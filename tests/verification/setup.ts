// Loads the local development environment for the verification harness, which —
// unlike the unit suite — talks to a real PostgreSQL database. Nothing here is
// printed, and no value is ever asserted on.
import { config } from 'dotenv';

config({ path: '.env.local' });

// A local `.env.local` may not carry the auth URL the env schema requires, and
// this harness never exercises auth. `@/lib/require-auth` is stubbed, so this is
// a placeholder for schema validation only.
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
