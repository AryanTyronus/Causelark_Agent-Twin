// @polsia:user-owned
//
// SECURE owner-scoped API route. COPY THIS SHAPE for any per-user resource:
// `requireAuth()` + every query scoped by the caller's id.
// Never query user data without `where: { userId: user.id }` (IDOR).
//
// As shipped it reads/updates the caller's own `user` row (so it compiles on
// install). For your own model use a scalar `userId String` (NOT a Prisma
// @relation to User — see AGENT.md), then use the owner-scoped queries below.

import 'server-only';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

// GET /api/example-secure — return ONLY the signed-in caller's data.
export async function GET(_req: Request) {
  let user: SessionUser;
  try {
    user = await requireAuth(_req);
  } catch (res) {
    return res as Response; // 401 from requireAuth — never redirect a fetch
  }

  // Scoped to the caller. For your own model:
  //   prisma.item.findMany({ where: { userId: user.id } })
  // NEVER findUnique({ where: { id } }) with a request id (IDOR).
  const me = await prisma.user.findUnique({
    where: { id: user.id },
    select: { id: true, name: true, email: true, role: true },
  });
  return NextResponse.json({ data: me });
}

// POST /api/example-secure — create a row owned by the caller. The owner is the
// session user, never a userId from the request body.
export async function POST(req: Request) {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }

  const body = (await req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  // Owner is the session user. For your own model:
  //   prisma.item.create({ data: { name, userId: user.id } })
  // Here we update the caller's own profile name so the example installs.
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { name },
    select: { id: true, name: true },
  });
  return NextResponse.json({ data: updated }, { status: 201 });
}

// PATCH /api/example-secure — owner-scoped update. For your own model put the
// owner in the WHERE so it updates 0 rows when the id isn't the caller's:
//   prisma.item.updateMany({ where: { id, userId: user.id }, data })
export async function PATCH(req: Request) {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }

  const body = (await req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  const result = await prisma.user.updateMany({
    where: { id: user.id },
    data: { name },
  });
  if (result.count === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
