// @polsia:shared — edit only through declared slots. Code installed by polsia/template-next@0.3.0.
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
    // D24: Prisma is the framework-native DB client. DATABASE_URL is
    // injected by Polsia at deploy time (D23). The actual Postgres is
    // provisioned by a separate Polsia service; this module ships the
    // client only.
    DATABASE_URL: z.string().url(),
    // @polsia:slot env_vars_server start
    // Modules append additional server-side env vars here at install time.
    // @polsia:contrib better-auth start
    BETTER_AUTH_SECRET: z.string().min(1),
    BETTER_AUTH_URL: z.string().url(),
    BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
    POLSIA_OWNER_EMAIL: z.string().optional(),
    // @polsia:contrib better-auth end
    // @polsia:contrib ai start
    POLSIA_AI_BASE_URL: z.string().url().default('https://polsia.com/ai/openai/v1'),
    POLSIA_API_KEY: z.string().min(1).optional(),
    POLSIA_API_TOKEN: z.string().min(1).optional(),
    // @polsia:contrib ai end
    BEDROCK_MODEL_ID: z.string().min(1).optional(),
    BEDROCK_REGION: z.string().min(1).optional(),
    AWS_REGION: z.string().min(1).optional(),
    // @polsia:contrib agent-twin-provider start
    // Which model provider backs the Agent Twin agent path. Selection is
    // explicit: an unrecognised value fails the turn rather than silently
    // switching providers. Unset defaults to `bedrock`, the intended AWS
    // provider, so existing deployments keep their behaviour.
    AGENT_PROVIDER: z.enum(['bedrock', 'agentrouter']).optional(),
    // AgentRouter is the development provider (OpenAI-compatible). These are
    // server-side only — the API key is never bundled into client code.
    AGENTROUTER_BASE_URL: z.string().url().optional(),
    AGENTROUTER_API_KEY: z.string().min(1).optional(),
    AGENTROUTER_MODEL: z.string().min(1).optional(),
    // @polsia:contrib agent-twin-provider end
    // @polsia:slot env_vars_server end
  },

  client: {
    NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
    // Base for @/lib/api-client + proxy.ts connect-src. Default-empty
    // (unset) means same-origin `/api`; set only for an external API origin.
    NEXT_PUBLIC_API_URL: z.string().url().optional(),
    // @polsia:slot env_vars_client start
    // Modules append NEXT_PUBLIC_* env vars here at install time.
    // @polsia:slot env_vars_client end
  },

  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    // @polsia:slot env_runtime start
    // Modules append runtime-env entries here at install time.
    // @polsia:contrib better-auth start
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    BETTER_AUTH_TRUSTED_ORIGINS: process.env.BETTER_AUTH_TRUSTED_ORIGINS,
    POLSIA_OWNER_EMAIL: process.env.POLSIA_OWNER_EMAIL,
    // @polsia:contrib better-auth end
    // @polsia:contrib ai start
    POLSIA_AI_BASE_URL: process.env.POLSIA_AI_BASE_URL,
    POLSIA_API_KEY: process.env.POLSIA_API_KEY,
    POLSIA_API_TOKEN: process.env.POLSIA_API_TOKEN,
    // @polsia:contrib ai end
    BEDROCK_MODEL_ID: process.env.BEDROCK_MODEL_ID,
    BEDROCK_REGION: process.env.BEDROCK_REGION,
    AWS_REGION: process.env.AWS_REGION,
    // @polsia:contrib agent-twin-provider start
    AGENT_PROVIDER: process.env.AGENT_PROVIDER,
    AGENTROUTER_BASE_URL: process.env.AGENTROUTER_BASE_URL,
    AGENTROUTER_API_KEY: process.env.AGENTROUTER_API_KEY,
    AGENTROUTER_MODEL: process.env.AGENTROUTER_MODEL,
    // @polsia:contrib agent-twin-provider end
    // @polsia:slot env_runtime end
  },
  emptyStringAsUndefined: true,
  // SKIP_ENV_VALIDATION=1 bypasses validation for envless builds (lint/CI/local).
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});
