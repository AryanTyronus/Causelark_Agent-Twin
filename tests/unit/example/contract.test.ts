// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ExampleCreate, ExampleItem, ExampleList } from '@/lib/contracts/example';

// Neutralize server-only so the route handler can be unit-tested directly.
vi.mock('server-only', () => ({}));

describe('example shared contract', () => {
  it('ExampleCreate rejects an empty name and accepts a valid one', () => {
    expect(ExampleCreate.safeParse({ name: '' }).success).toBe(false);
    expect(ExampleCreate.safeParse({ name: 'Acme' }).success).toBe(true);
  });

  it('ExampleItem requires the server-generated id on top of the create fields', () => {
    expect(ExampleItem.safeParse({ name: 'Acme' }).success).toBe(false);
    expect(ExampleItem.safeParse({ id: 'x1', name: 'Acme' }).success).toBe(true);
  });

  it('ExampleList wraps an array of items and rejects id-less records', () => {
    expect(ExampleList.safeParse({ items: [] }).success).toBe(true);
    expect(ExampleList.safeParse({ items: [{ id: 'x1', name: 'Acme' }] }).success).toBe(true);
    expect(ExampleList.safeParse({ items: [{ name: 'Acme' }] }).success).toBe(false);
  });
});

describe('example route handler branches', () => {
  const post = (body: unknown) =>
    import('@/app/api/example/route').then(({ POST }) =>
      POST(new Request('http://test/api/example', { method: 'POST', body: JSON.stringify(body) })),
    );

  it('GET returns 200 with an empty, contract-valid list', async () => {
    const { GET } = await import('@/app/api/example/route');
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ items: [] });
  });

  it('POST with an invalid body returns 400 with a field error map', async () => {
    const res = await post({ name: '' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors.name).toBeTruthy();
  });

  it('POST with a valid body returns 201 with the created record (id assigned)', async () => {
    const res = await post({ name: 'Acme' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe('Acme');
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
  });
});
