// @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/better-auth. Drift = commit rejected.
//
// Server-side admin gate. Admin = a better-auth user with role 'admin' (the admin
// plugin in src/lib/auth.ts). Use at the TOP of an admin Server Component page:
//   const session = await requireAdmin(); // redirects unless the signed-in user is an admin
// Server-only — NEVER import this from a 'use client' file (breaks the build:
// "'server-only' cannot be imported from a Client Component"). If the admin page also needs
// client interactivity or loads data, keep the PAGE a Server Component that calls requireAdmin(),
// then render a 'use client' child island for the interactive part (fetch via apiFetch('/api/admin/...')).
// For an admin API route handler, return a 403 instead (see AGENT.md) — never redirect a fetch.
// NEVER hand-roll a separate admin login, a shared password, or a custom admin cookie.

import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

export async function requireAdmin() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'admin') redirect('/');
  return session;
}
