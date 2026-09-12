// @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/better-auth@0.8.0. Drift = commit rejected.
// Protected core (db/secret/baseURL, admin plugin, multi-host trustedOrigins) + owner-admin grant,
// composed with the app's own databaseHooks. Configure auth in @/lib/auth-config (user-owned).

import 'server-only';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { admin } from 'better-auth/plugins';
import { authConfig } from '@/lib/auth-config';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

// Compose the owner-admin grant with the app's hooks — don't overwrite them.
const appHooks = authConfig.databaseHooks;

// Multi-host auth: ONE build is served on <slug>.polsia.app, the <slug>.polsia.io
// backup domain, and custom brand domains — each must pass better-auth's
// Origin/CSRF check on sign-in/sign-up. The wildcards cover the Polsia serving
// domains (incl. any post-rename slug); BETTER_AUTH_TRUSTED_ORIGINS is injected
// per-deploy by the Polsia backend with the company's active custom domains.
// baseURL's own origin is always trusted implicitly. Framework-owned so an
// app can't accidentally narrow it back to a single host.
const trustedOrigins = [
  'https://*.polsia.app',
  'https://*.polsia.io',
  ...(env.BETTER_AUTH_TRUSTED_ORIGINS?.split(',')
    .map((o) => o.trim())
    .filter(Boolean) ?? []),
];

export const auth = betterAuth({
  ...authConfig,
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins,
  databaseHooks: {
    ...appHooks,
    user: {
      ...appHooks?.user,
      create: {
        ...appHooks?.user?.create,
        before: async (user, ctx) => {
          const r = await appHooks?.user?.create?.before?.(user, ctx);
          if (r === false) return false;
          const base = r && typeof r === 'object' && 'data' in r ? r.data : user;
          const owner = env.POLSIA_OWNER_EMAIL?.toLowerCase();
          if (owner && user.email.toLowerCase() === owner) {
            return { data: { ...base, role: 'admin' } };
          }
          return r;
        },
      },
    },
  },
  plugins: [
    admin({
      defaultRole: 'user',
      adminRoles: ['admin'],
    }),
    ...(authConfig.plugins ?? []),
  ],
});
