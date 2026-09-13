//
// Typed env via @t3-oss/env-nextjs.
//
// Modules contribute env vars via their manifest `contributions` block.
// The installer regenerates this file's slots between the markers below.
// Hand-editing outside those slots is rejected by the ownership validator.
//
// The `no-secrets-in-client-bundle` validator scans the build output and rejects
// the install if any non-NEXT_PUBLIC_ env name appears in client chunks.

import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().url(),
    // Modules append additional server-side env vars here at install time.
    BETTER_AUTH_SECRET: z.string().min(1),
    BETTER_AUTH_URL: z.string().url(),
    BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
    BEDROCK_MODEL_ID: z.string().min(1).optional(),
    BEDROCK_REGION: z.string().min(1).optional(),
    AWS_REGION: z.string().min(1).optional(),
    // Which model provider backs the Agent Twin agent path. Selection is
    // explicit: an unrecognised value fails the turn rather than silently
    // switching providers. Unset defaults to `bedrock`, the intended AWS
    // provider, so existing deployments keep their behaviour.
    AGENT_PROVIDER: z.enum(['bedrock', 'openrouter']).optional(),
    // OpenRouter is the development provider (OpenAI-compatible). These are
    // server-side only — the API key is never bundled into client code.
    OPENROUTER_BASE_URL: z.string().url().optional(),
    OPENROUTER_API_KEY: z.string().min(1).optional(),
    OPENROUTER_MODEL: z.string().min(1).optional(),
  },

  client: {
    NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
    // Base for @/lib/api-client + proxy.ts connect-src. Default-empty
    // (unset) means same-origin `/api`; set only for an external API origin.
    NEXT_PUBLIC_API_URL: z.string().url().optional(),
    // Modules append NEXT_PUBLIC_* env vars here at install time.
  },

  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    // Modules append runtime-env entries here at install time.
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    BETTER_AUTH_TRUSTED_ORIGINS: process.env.BETTER_AUTH_TRUSTED_ORIGINS,
    BEDROCK_MODEL_ID: process.env.BEDROCK_MODEL_ID,
    BEDROCK_REGION: process.env.BEDROCK_REGION,
    AWS_REGION: process.env.AWS_REGION,
    AGENT_PROVIDER: process.env.AGENT_PROVIDER,
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
  },
  emptyStringAsUndefined: true,
  // SKIP_ENV_VALIDATION=1 bypasses validation for envless builds (lint/CI/local).
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});
