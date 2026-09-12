// @polsia:framework-owned — DO NOT EDIT. The ONLY data transport for client
// pages. Native fetch only. Do NOT add SWR/react-query/axios for app data —
// the data plane is apiFetch + zod contracts (see src/lib/contracts/). Client
// pages call apiFetch('/api/<resource>'); route handlers under src/app/api own
// the DB.
//
// Pass a zod `schema` to validate+parse the response so the typed result is
// PROVEN at runtime, not an unchecked cast — this is what catches client/server
// contract drift the tsc gate cannot. Import the schema from the shared
// contract for the resource (single source of truth shared with the handler).
import type { ZodType } from 'zod';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

type ApiFetchOptions<T> = RequestInit & {
  // When provided, the JSON body is run through `schema.parse` on success so
  // the returned value is a validated `T` rather than an unchecked cast.
  schema?: ZodType<T>;
};

// Overload 1: no schema — unchecked cast (use only when there is no contract).
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T>;
// Overload 2: with schema — parsed + validated, T is inferred from the schema.
export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions<T> & { schema: ZodType<T> },
): Promise<T>;
export async function apiFetch<T>(path: string, options?: ApiFetchOptions<T>): Promise<T> {
  const { schema, ...init } = options ?? {};
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  // future: const token = ...; headers.set('Authorization', `Bearer ${token}`);
  // Token-ready seam — NOT implemented now. No cookies, no CSRF.

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`apiFetch ${path} failed (${res.status})`, { cause: body });
  }
  // schema.parse throws ZodError on drift — surfaces the mismatch instead of
  // letting a wrong shape flow silently into typed UI code.
  return schema ? schema.parse(body) : (body as T);
}
