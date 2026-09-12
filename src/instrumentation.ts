// @polsia:framework-owned — DO NOT EDIT. Next.js server-startup hook.
//
// Next calls register() ONCE when the server process boots. We use it to run the
// app's idempotent startup seed AFTER the schema is applied: polsia.toml's `start`
// runs `prisma db push` before `npm start`, so by the time this fires the tables
// exist. Put seed logic in src/lib/seed.ts (user-owned) — this file only owns the
// correctness envelope the agent must not get wrong:
//   - Node-runtime guard: register() ALSO fires for the edge runtime, where Prisma
//     cannot run, so we return early there and never pull server-only code into an
//     edge bundle.
//   - fail-open: a throwing seed is logged and swallowed, never re-thrown, so a bad
//     seed can never stop the server from booting (a failure in the `start` chain
//     would). Seed failures degrade gracefully.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  try {
    const { seed } = await import('@/lib/seed');
    await seed();
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: startup diagnostics — the seed failed but the server still boots.
    console.error('[polsia] startup seed failed:', error);
  }
}
