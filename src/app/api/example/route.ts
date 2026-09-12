// @polsia:user-owned — reference route handler. Copy this shape for real
// resources, then delete the example route.
import 'server-only';
import { NextResponse } from 'next/server';
import { ExampleCreate, ExampleItem, ExampleList } from '@/lib/contracts/example';
// DB seam — uncomment to read/write via the server-only Prisma singleton:
// import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  // const items = await prisma.example.findMany();
  // Validate responses against the same contract the client parses.
  const payload = ExampleList.parse({ items: [] });
  return NextResponse.json(payload);
}

export async function POST(req: Request) {
  try {
    const parsed = ExampleCreate.safeParse(await req.json());
    if (!parsed.success) {
      // 400 body shape consumed by applyServerErrors: { errors: { field: message } }.
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const errors: Record<string, string> = {};
      for (const [field, messages] of Object.entries(fieldErrors)) {
        const message = messages?.[0];
        if (message) {
          errors[field] = message;
        }
      }
      return NextResponse.json({ errors }, { status: 400 });
    }
    // const created = await prisma.example.create({ data: parsed.data });
    // Replace the synthesized id with the persisted row once a model is wired.
    const created = ExampleItem.parse({ id: crypto.randomUUID(), ...parsed.data });
    return NextResponse.json(created, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
