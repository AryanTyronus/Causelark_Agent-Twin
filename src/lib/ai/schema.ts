// @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/ai@0.1.0. Drift = commit rejected.
//
// Shared schemas for Polsia-managed AI calls. Safe to import from client
// components: this file has no server-only imports and does not expose secrets
// or any LLM SDK. The public /api/ai/chat route validates request bodies with
// chatRequestSchema; the server-only client adds vision/structured helpers.

import { z } from 'zod';

export const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
});

export const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(50),
  model: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
