# polsia-next-v2

The canonical Next.js template for Polsia-generated customer apps.

This repository is a scaffold with the shadcn UI baseline built in. It ships the
framework defaults every app needs on day one: Next.js 16 App Router, React 19,
Tailwind 4, Prisma client wiring, Biome, Vitest, security headers, a token-driven
theme, and a broad shadcn primitive set. Product capabilities such as auth,
billing, email, analytics, dashboards, and multi-tenant workflows are installed
from `Polsia-Inc/modules`.

## What This Is

This is a template, not a hand-customized starter app. The Polsia engineering
agent reads the ownership map, installs modules when needed, and edits only the
bounded app-owned zones. The directory shape and `.polsia/ownership.json` are
the contract that keeps framework files, module files, and customer code
separate.

The canonical template id is `polsia-next-v2`; the GitHub repository is
`Polsia-Inc/template-next`.

## What Is Included

- Next.js 16 App Router, React 19, TypeScript, and Tailwind 4.
- shadcn UI baseline: `components.json`, `cn()`, a committed primitive set in
  `src/components/ui/**`, sonner toasts, next-themes, and theme tokens in
  `src/app/globals.css`.
- Prisma 6 client setup: `prisma/schema/_base.prisma`, `prisma.config.ts`, and
  the server-only singleton in `src/lib/db.ts`. The actual database is external;
  Polsia provisions Postgres and injects `DATABASE_URL`.
- Typed environment validation through `src/lib/env.ts`.
- Data-plane examples: a shared zod contract, an `/api/example` route handler,
  and a client page that uses `apiFetch`.
- CSP and security headers in `proxy.ts`, `next.config.ts`, and
  `src/lib/csp.ts`.
- SEO plumbing: `src/lib/brand.ts`, `src/lib/site.ts`, `robots.ts`,
  `sitemap.ts`, `manifest.ts`, a default Open Graph image route, and an
  `/llms.txt` route (llmstxt.org) for AI/LLM crawlers curated via
  `src/lib/llms-config.ts`.
- Unit tests covering the ownership map, CSP posture, env validation, and the
  example data contract.

## What Is Not Included

- No auth, billing, email, analytics, dashboards, or other product modules.
- No database server, Dockerfile, compose file, or Procfile.
- No real env files. `.env.example` documents the expected variables; deploys
  receive actual values from the platform.
- No Server Actions. Product pages call `/api/*` route handlers through
  `src/lib/api-client.ts`.

## Ownership Model

Always read `.polsia/installed.json`, `.polsia/ownership.json`, and
`.polsia/overrides.json` before editing.

| Tier | Examples | Who edits |
| --- | --- | --- |
| `framework_owned` | `src/lib/db.ts`, `src/lib/utils.ts`, `components.json`, `prisma.config.ts`, `AGENTS.md`, `.polsia/installed.json`, `.polsia/ownership.json` | Framework or owning module only. |
| `user_owned` | `src/components/ui/**`, `src/app/(setup)/page.tsx`, `src/app/(custom)/**`, `src/lib/brand.ts`, `src/lib/nav.ts`, `public/**`, `README.md`, `.polsia/overrides.json` | The app agent or customer. |
| `shared` | `src/app/globals.css`, `src/lib/env.ts`, `src/app/layout.tsx`, `proxy.ts`, `next.config.ts`, `package.json`, `.env.example` | Edit only through declared slots or the documented merge strategy. |

`.polsia/ownership.json` is the source of truth. Source banners are reader
signage only.

## What Not To Edit

- Anything marked `framework_owned` in `.polsia/ownership.json`.
  Comment-capable source files carry `@polsia:framework-owned` banners as
  signage, but the ownership map is the authority.
- Anything outside declared slot markers in shared files such as
  `next.config.ts`, `proxy.ts`, `src/lib/env.ts`, `src/app/layout.tsx`, and
  `src/app/globals.css`.
- `.polsia/installed.json` and `.polsia/ownership.json`. They are generated
  state files. Use `.polsia/overrides.json` for hand-editable module policy.

## Platform Rules

- Keep Cache Components off unless the platform explicitly changes that policy.
- Use `proxy.ts`; do not add `middleware.ts`.
- Keep data and mutations behind `/api/*` route handlers. Do not add Server
  Actions.
- Keep Prisma datasource and generator declarations in `prisma/schema/_base.prisma`.
  App or module schema files add models only.
- `src/app/(auth)/**` and `src/app/(dashboard)/**` pages are user-owned — build and
  restyle them freely. Don't hand-roll the auth security surface (`src/lib/auth.ts`,
  `src/app/api/auth/**`, the prisma auth schema, `require-auth`/`require-admin`):
  those are framework-owned, installed by the auth module.
- Put recurring work in `polsia.toml` `[[crons]]`; do not use in-process
  schedulers for product behavior.

## Agent Workflow

1. Read `AGENTS.md` and the three `.polsia/` state files.
2. Decide whether the request is app-specific UI/business logic or a reusable
   capability that should come from a module.
3. Install modules through the Polsia module installer when a module owns the
   capability. Do not clone module files by hand.
4. Write app-specific code in user-owned areas:
   - Routes: `src/app/(custom)/<feature>/page.tsx`
   - API handlers: `src/app/api/<resource>/route.ts`
   - Contracts: `src/lib/contracts/<resource>.ts`
   - Business logic: `src/lib/business/<feature>.ts`
   - Custom components: `src/components/custom/<feature>.tsx`
   - Hooks: `src/hooks/use-<feature>.ts`
5. Replace the starter home by editing `src/app/(setup)/page.tsx` in place, or
   delete the `(setup)` route group before adding another page that resolves to
   `/`.
6. Set the product identity in `src/lib/brand.ts`, update `src/lib/nav.ts` for
   reachable public pages, and rely on the built-in robots, sitemap, metadata,
   and Open Graph plumbing.
7. Keep every feature reachable from the home page or, for authenticated
   features, the dashboard.
8. Run the relevant checks before shipping.

Module installs go through the Polsia module installer. The installer owns
module file writes, ownership-map updates, install hashes, and module validators.
Do not clone module files or copy them by hand.

## Data Plane

Product pages are client components. They call route handlers through
`apiFetch`, passing a shared zod schema to validate the response at runtime.

Each resource should have one shared contract in `src/lib/contracts/<resource>.ts`.
The route handler validates request and response shapes with that contract, and
the client imports the same schema.

Validation errors from route handlers use:

```ts
{ errors: { fieldName: 'Message' } }
```

Client forms map those errors with `applyServerErrors`. Transient success or
unexpected failure feedback should use `toast` from `sonner`.

## UI

The template already includes a broad shadcn primitive set under
`src/components/ui/**`. Compose those primitives first, restyle through theme
tokens and component variants, and add new primitives with:

```bash
npx shadcn@latest add <name> --yes
```

Reusable app-specific UI belongs in `src/components/custom/**`.

## Directory Guide

```text
.
├── .polsia/                          Generated state and ownership map
├── prisma/
│   ├── schema/_base.prisma           Datasource + generator only
│   └── migrations/migration_lock.toml Project-level migration lock
├── public/                           Customer assets
├── src/
│   ├── app/
│   │   ├── (setup)/page.tsx          Starter home served at /
│   │   ├── (custom)/example/page.tsx Data-plane example page
│   │   ├── api/example/route.ts      Data-plane example route
│   │   ├── health/route.ts           Deploy healthcheck
│   │   ├── layout.tsx                Root layout and providers slot
│   │   └── globals.css               Tailwind theme and brand token slot
│   ├── components/
│   │   ├── ui/                       shadcn primitives
│   │   ├── custom/                   App-owned compositions
│   │   └── theme-provider.tsx        next-themes wrapper
│   ├── hooks/                        App-owned React hooks
│   ├── lib/
│   │   ├── api-client.ts             Client transport helper
│   │   ├── brand.ts                  Product name and description
│   │   ├── contracts/example.ts      Example shared zod contract
│   │   ├── csp.ts                    CSP builder
│   │   ├── db.ts                     Prisma singleton
│   │   ├── env.ts                    Typed env schema
│   │   ├── forms.ts                  Server error mapping
│   │   ├── nav.ts                    App navigation config
│   │   └── utils.ts                  cn()
│   └── modules/                      Vendored module installs
├── tests/unit/                       Vitest unit tests
├── next.config.ts                    Next config and security headers
├── proxy.ts                          CSP nonce and middleware chain slot
├── polsia.toml                       Deploy manifest and scheduled jobs
└── AGENTS.md                         Engineering agent operating manual
```

## Security Headers

`next.config.ts` sets baseline response headers:

- `Strict-Transport-Security`
- `X-Content-Type-Options`
- `X-Frame-Options`
- `Referrer-Policy`
- `Permissions-Policy`
- `Cross-Origin-Opener-Policy`
- `Cross-Origin-Resource-Policy`

`proxy.ts` sets a per-request Content Security Policy. `script-src` stays strict
with a nonce and `strict-dynamic`; `style-src` allows inline styles so Radix and
shadcn runtime positioning works in production.

## Day-1 Validators

The bare scaffold validator floor is declared in
`.polsia/installed.json#day_1_floor`. Module-specific validators are added by
module manifests when modules install.

- `no-secrets-in-client-bundle`
- `server-only-import-on-secret-modules`
- `agent-has-no-prod-db-credentials`
- `db-ssl-required`
- `parameterized-queries-only`
- `security-headers-present`
- `lockfile-committed-and-pinned`
- `lifecycle-scripts-disabled`
- `next-version-not-affected-by-cve-2025-29927`

## Local Development

Node 22 or newer is required (`.nvmrc` pins `22`; `package.json#engines` declares
`>=22.0.0`). The Agent Twin providers run on the Strands Agents SDK: the Bedrock
provider signs its requests with the AWS SDK, and both need the Node runtime.
The framework `.npmrc` sets
`engine-strict=false`, so npm warns rather than refuses on an older Node — CI pins
22 via `.nvmrc`, and an older runtime is not a supported configuration.

Use npm; the lockfile is committed.

```bash
nvm use                                          # Node 22 from .nvmrc
npm ci
npm run typecheck
npm run lint
npm run test
SKIP_ENV_VALIDATION=1 npm run dev
```

`npm run dev` and `npm run build` validate `DATABASE_URL` and
`NEXT_PUBLIC_APP_URL` when `SKIP_ENV_VALIDATION` is not set. On a local clone
without a provisioned database, either set the required vars in `.env.local` or
prefix the command with `SKIP_ENV_VALIDATION=1`.

`typecheck`, `lint`, and `test` do not require env. With no modules installed,
`/` serves the `(setup)` placeholder until a module or app-authored root page
takes over.

## CI/CD

`.github/workflows/ci.yml` runs on every push and PR to `main`: `npm run lint`,
`npm run test`, `npm run build` (with `SKIP_ENV_VALIDATION=1`), then
`npm run typecheck`. Every gate runs even if an earlier one failed, so one red
build shows every problem at once.

Typecheck runs **after** the build on purpose: `tsconfig.json` includes
`.next/types/**`, where Next generates route-handler and page prop types.
Running `tsc` before a build silently skips them.

Releases are two-phase. **`release.yml`** (Actions tab, manual) takes a
`patch`/`minor`/`major` bump, an exact `version`, or `dry_run` to preview. It
re-runs `ci.yml` against the commit being released, bumps `package.json` on a
`release/v<version>` branch, pushes it, and prints a link to open the PR. **You
open that PR** — a PR created with `GITHUB_TOKEN` never triggers its own checks,
so its required checks would never report. Merging it fires
**`tag-release.yml`**, which creates the `v<version>` tag and the GitHub
Release.

The bump goes through a PR rather than a direct push because a branch ruleset
requiring status checks rejects a fresh commit pushed straight to `main`, and
GitHub refuses an `Integration` bypass actor that is not registered on the org.

Nothing is published to npm (this package is `private: true`). The version bump
on `main` is what the fleet converges on: the backend pulls this `package.json`
and compares it to each codebase's pinned template version, so a bump fires
nothing by itself — each company re-stamps at the end of its next successful
engineering run.

## Versions

Pinned exact versions are used for the framework stack:

- Next.js 16.2.6, App Router
- React 19.2.7
- Tailwind CSS 4.3.0, CSS-first `@theme`
- shadcn/ui New York style
- sonner 2.0.7
- TypeScript 5.5.4, strict mode
- Biome 2.3.1, lint and format
- Vitest 3.2.6
- Prisma 6.19.3
- Node >=22.0.0 (pinned in `.nvmrc`)

Security `overrides` in `package.json` pin patched transitive dependency
versions that direct framework pins cannot reach on their own.

## Causelark Agent Twin MVP

The simulation lab follows a persistent configure → run → inspect workflow.
Choose an environment, objective, and seed; start a run; advance one bounded
agent turn at a time; and inspect the persisted observation, explicit Strands
tool calls, validation outcomes, state changes, metrics, and replay frames at
`/dashboard/simulations/<runId>`.

### Provider: Strands Agents SDK on Amazon Bedrock (or AgentRouter for development)

The Agent Twin agent path runs the official Strands Agents TypeScript SDK
(`@strands-agents/sdk`). Two model providers are selectable, and both are Strands
model clients driving the same bounded agent loop, the same allow-listed
simulation tools, and the same validation, persistence, metrics and replay path —
only the model client differs. The provider boundary is one file,
`src/lib/agent/provider.ts`; nothing in `src/lib/agent/**` imports the raw `openai`
package or the Polsia AI proxy.

| Provider | `AGENT_PROVIDER` | Model client | Intended use |
| --- | --- | --- | --- |
| **Amazon Bedrock** | `bedrock` (default) | `BedrockModel`, driving the Bedrock Converse API via `@aws-sdk/client-bedrock-runtime` | **Production and the AWS/hackathon deployment.** The intended provider. |
| **AgentRouter** | `agentrouter` | Strands' native OpenAI-compatible `OpenAIModel` in Chat Completions mode | **Development and testing only.** Lets the Agent Twin run locally before AWS credentials exist. |

Selection is explicit and never falls back: an unrecognised `AGENT_PROVIDER`
fails the turn with a visible configuration error instead of quietly running —
and billing — the other provider. Unset keeps the previous behaviour and selects
Bedrock, so an existing deployment is unaffected.

#### Amazon Bedrock (default)

| Variable | Required | Purpose |
| --- | --- | --- |
| `BEDROCK_MODEL_ID` | yes | Bedrock model or inference-profile identifier. Unset means turns fail with a visible configuration error rather than running a billed default model. |
| `BEDROCK_REGION` | no | Region for the Bedrock client. Falls back to `AWS_REGION`. |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | no | Standard AWS region resolution. |

Credentials are **never** read from application env vars and never stored in
this repo. The AWS SDK resolves them through its standard credential provider
chain — environment, shared `~/.aws/credentials` and `~/.aws/config` profiles,
SSO, container and instance metadata, and web identity. The identity needs
`bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the chosen
model, plus model access granted in the Bedrock console for that region.

#### AgentRouter (development)

An OpenAI-compatible endpoint, reached through the Strands SDK's own
OpenAI-compatible adapter rather than a parallel agent architecture, so the agent
keeps genuine tool calling: it observes resources, decides, requests an action,
has that action validated against the simulation, observes the changed state, and
continues — exactly as under Bedrock.

| Variable | Required | Purpose |
| --- | --- | --- |
| `AGENT_PROVIDER` | yes | Set to `agentrouter` to select this provider. |
| `AGENTROUTER_API_KEY` | yes | Server-side API key. Unset means turns fail with `missing_configuration` rather than calling anonymously. |
| `AGENTROUTER_BASE_URL` | no | Endpoint base. Defaults to `https://agentrouter.org/v1`; the client appends `/chat/completions`. Configurable so an operator can point elsewhere. |
| `AGENTROUTER_MODEL` | no | Model ID. Defaults to `deepseek-v4-flash`. |

The API key is server-only. It is read from validated server env, passed to the
model client, and never returned in a response, persisted with a turn, or written
to a log — the same containment the AWS credentials get. `.env.example` carries
placeholders only; real credentials belong in `.env.local`, which is gitignored.

Provider failures from either provider are normalized into the same safe codes
(`missing_configuration`, `missing_credentials`, `access_denied`, `throttled`,
`timeout`, `provider_error`) with fixed, non-sensitive messages, worded for the
provider that was actually selected. SDK error text, ARNs, account IDs, request
bodies, authorization headers, and credentials are never returned to the client
or written to logs. The persisted turn records which provider ran, so a run is
never ambiguous about the model that produced it.

### Bounded multi-step turns

`POST /api/simulations/runs/<runId>/agent-step` stays request-triggered: one HTTP
call performs one *bounded* turn. Inside that turn the agent may run several
observe → act → observe cycles so it can confirm the effect of an action before
deciding the next one. Two independent limits make an unbounded loop impossible:

- a per-turn action allowance on `request_action` (default 3), after which
  further requests are refused without touching state; and
- a model-call allowance passed to the SDK as `limits.turns` (derived from the
  action allowance and hard-capped at 12), plus a wall-clock budget
  (`configuration.toolTimeoutMs`).

Tools are a fixed allow-list (`observe_resources`, `request_action`) and are
executed sequentially because they share one mutable environment copy. Every
requested action still goes through `evaluateSimulationAction`; a rejected action
returns a reason and never mutates simulation state. The simulation state, not
the model's narration, remains the source of truth.

### Determinism

The environment and its transition engine are deterministic: the same seed plus
the same validated action sequence always produces the same trajectory, which is
what replay reconstructs from persisted records. The model's choice of actions is
**not** deterministic and is not claimed to be — a rerun reports
`transitionEngine: 'deterministic'` and `providerDecisionPath: 'variable'`
separately.

### Persistence and replay

Every turn persists, in order: the tool calls with their inputs, outputs,
validation outcomes and latency; the validated or rejected actions with the state
they produced; and the event timeline (turn started, observation, tool requested,
tool result, action requested, action validated/rejected, state change, turn
completed, terminal). Metrics and replay frames are derived from those records
rather than from any client state, and private chain-of-thought is never
persisted — the agent's observable output is limited to tool calls and their
results.

Simulation tables are owned by this app, not the framework: they live in
`prisma/migrations/20260912000000_add_simulation_tables/migration.sql`, a purely
additive user-owned migration that does not touch the framework-owned better-auth
migrations or `migration_lock.toml`.

### Remaining legacy surface

The framework's own `ai` module (`src/lib/ai/client.ts`,
`src/app/api/ai/chat/route.ts`) still talks to the Polsia AI proxy and still
reads `POLSIA_AI_BASE_URL` / `POLSIA_API_KEY` / `POLSIA_API_TOKEN`. That code is
unrelated to the Agent Twin and is deliberately left as-is; the Agent Twin path
does not import it.

Local verification needs the usual database/auth environment. Because AWS
credentials resolve through the standard chain, a local agent-step call under the
default Bedrock provider without reachable credentials intentionally persists a
visible failure rather than silently running a fake agent. To exercise the real
agent loop locally before AWS credentials exist, set `AGENT_PROVIDER=agentrouter`
with an `AGENTROUTER_API_KEY`; the turn records that provider by name, and the
Bedrock path is unchanged.

## License

MIT. See [LICENSE](./LICENSE).
