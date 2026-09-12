// @polsia:user-owned — shared zod contract for the example resource. Copy this
// shape for real API resources, then delete the example contract.
// Keep contract modules client-importable: zod only, no server-only imports.
import { z } from 'zod';

// Write shape: fields a client may submit.
export const ExampleCreate = z.object({
  name: z.string().min(1, 'Name is required').max(120, 'Name is too long'),
});

// Read shape: persisted record returned by the server.
export const ExampleItem = ExampleCreate.extend({
  id: z.string(),
});

// GET response envelope.
export const ExampleList = z.object({
  items: z.array(ExampleItem),
});

export type ExampleCreate = z.infer<typeof ExampleCreate>;
export type ExampleItem = z.infer<typeof ExampleItem>;
export type ExampleList = z.infer<typeof ExampleList>;
