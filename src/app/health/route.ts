// @polsia:framework-owned — DO NOT EDIT. Required by the deploy pipeline's healthcheck.
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ status: 'healthy' });
}
