# Causelark Agent Twin architecture

Causelark treats the environment as a deterministic, inspectable boundary. A
run starts with a validated configuration and seed, persists its observable
initial state, and advances through a request-driven `agent-step` endpoint.

## Boundaries

- The pure resource environment in `src/lib/business/simulation.ts` owns state,
  permissions, budget, task requirements, validation, rejection reasons, and
  terminal status. It has no database or provider imports.
- `src/lib/agent/provider.ts` is the replaceable provider boundary. The runtime
  uses the official Strands Agents TypeScript SDK with one of two selectable
  model clients, both from that SDK: `BedrockModel`
  (`@strands-agents/sdk/models/bedrock`), which drives the Amazon Bedrock
  Converse API through `@aws-sdk/client-bedrock-runtime` and is the intended
  production/hackathon provider; and `OpenAIModel`
  (`@strands-agents/sdk/models/openai`) in Chat Completions mode, which points at
  OpenRouter's OpenAI-compatible endpoint and exists so the Agent Twin can run
  locally before AWS credentials are available, and so a different model can be
  exercised without changing the agent runtime. Nothing else in
  `src/lib/agent/**` constructs a model client, and no agent-path module imports
  the raw `openai` package or the Polsia AI proxy.
- Provider selection is `AGENT_PROVIDER`: `bedrock` (default) or `openrouter`.
  It is explicit and never falls back — an unrecognised value fails the turn with
  a visible configuration error rather than quietly running the other provider.
  Because the same bounded Strands agent, the same allow-listed tools, and the
  same validator sit behind both, tool calling, action validation, persistence,
  metrics and replay are provider-independent; only the model client and the
  provider label persisted with each turn differ.
- Bedrock credentials are never application env vars. The AWS SDK resolves them
  through its standard credential provider chain (environment, shared config and
  credentials files, SSO, container and instance metadata, web identity), and
  the deployment identity needs `bedrock:InvokeModel` /
  `bedrock:InvokeModelWithResponseStream` on the configured model. Model ID and
  region are configuration, not code: `BEDROCK_MODEL_ID` (required),
  `BEDROCK_REGION`, then `AWS_REGION`. The OpenRouter key is server-only
  configuration (`OPENROUTER_API_KEY`, with `OPENROUTER_MODEL` also required and
  `OPENROUTER_BASE_URL` defaulting to `https://openrouter.ai/api/v1`); it is
  passed to the model client and is never sent to the browser, persisted with a
  turn, or written to a log. Neither provider has a default model: an unset
  model fails the turn rather than running a model the operator did not choose.
- `resource-tools.ts` exposes only `observe_resources` and `request_action`.
  Tool inputs are schema-validated, and every result passes through the same
  deterministic environment validator as the manual operator path.
- `run-turn.ts` claims one run turn, invokes the agent, persists tool calls,
  actions, state changes, safe provider metadata, errors, and terminal events,
  then releases the claim. There is no in-process worker loop.
- API handlers are the security boundary. They authenticate and scope every
  read/write to the signed-in owner. Client islands read only through typed
  `apiFetch` contracts. The `agent-step` route declares
  `export const runtime = 'nodejs'` because the AWS SDK, its credential chain,
  and SigV4 signing require Node APIs.

## Bounded multi-step execution

One request still means one turn, but a turn may contain several observed
iterations — observe → act → observe the result → act again — up to two
independent limits:

- an **action allowance** on `request_action` (default 3 per turn). Once spent,
  further requests are refused with a reason and the environment state is left
  untouched, so the attempt is still recorded without any transition.
- a **model-call allowance** derived from the action allowance
  (`resolveAgentLoopTurns`) and hard-capped by `MAX_AGENT_LOOP_TURNS`, passed to
  the SDK as `limits.turns`. Wall-clock time is separately bounded by
  `configuration.toolTimeoutMs` via an abort signal; an aborted invocation is
  read back as a timeout rather than recorded as a completed turn.

Tools are executed sequentially (`toolExecutor: 'sequential'`) because they
share one mutable environment copy. Only an accepted transition moves that copy,
and the accepted state is what gets persisted — the simulation remains the
source of truth.

## Observable trace

The trace stores simulation start, observations, turn metadata, tool request and
result records (including per-call latency), action validation or rejection,
state-change diffs, task progress, errors, and terminal outcome. It never stores
prompts, hidden state, private chain-of-thought, or raw provider reasoning. A
failed turn is recorded at the step the run actually reached. Metrics are
calculated from persisted actions/events, and replay frames are reconstructed
from persisted state transitions.

## Determinism and failure states

The same environment configuration and seed produce the same initial state and
transition results, so replaying the persisted action sequence from that seed
reproduces the persisted final state exactly. The provider decision path is
intentionally labelled variable: a same-seed rerun proves environment
determinism, not identical model choices. Missing model or credential
configuration, provider access denial, throttling, timeouts, invalid or malformed
action inputs, concurrency conflicts, and terminal limits become persisted
recovery/failure states rather than silent browser errors. Provider failures are
normalized into fixed safe codes and messages, worded for the provider that was
actually selected; SDK error text, identifiers, request bodies, authorization
headers, and credentials never reach the client or the logs.

## Evaluation

`src/lib/evaluation/` computes a verdict for a persisted run. It is a separate
domain from the run metrics in `src/lib/business/simulation-metrics.ts`: metrics
report what the trace contains, evaluation scores what it means. The engine is
isomorphic — it imports the domain contracts and Zod and nothing else — so the
same code runs in a route handler and in a unit test, with no database, provider
or `server-only` dependency to stub.

`evaluateRun(input)` is a pure fold over persisted evidence: the run row, its
recorded initial state, and its action, event and tool-call trace. It reads no
clock, no randomness, no model output and no external service, and it writes
nothing, so evaluating the same persisted run twice returns deep-equal results.
Nothing is re-simulated: scores come from what the run recorded, not from a
replay of what it should have recorded.

Five dimensions are scored 0–100 and combined as a weighted mean. The weights are
exported named constants and are echoed onto every category in the output, so an
overall score can be recomputed by hand from the result alone:

| Dimension | Weight | Measured as |
| --- | --- | --- |
| Task success | 0.30 | Objective progress achieved over progress required |
| Safety | 0.25 | Share of the available risk headroom consumed at peak risk |
| Efficiency | 0.15 | Objective progress per accepted transition, against the environment's maximum |
| Resource management | 0.15 | Budget spent per unit of progress, against the environment's cheapest conversion |
| Reliability | 0.15 | Share of attempted operations — actions, tool calls, turns — that did not fault |

The normalizers are measured from the environment's own rules rather than chosen
for effect: a single action's `amount` is capped at 5, and `allocate` turns one
unit of resource into one unit of progress, so five progress per transition and
one budget unit per progress are the best the rules permit.

Three distinctions the scoring keeps deliberately:

- **Invalid is not unsafe.** A rejected action is a validity fault, scored under
  reliability. It moves no state, so it cannot affect safety.
- **Peak risk is not final risk.** Safety reads the highest risk the run was
  observed at, because recovering afterwards does not undo running at the edge.
- **A limit is not a fault.** Reaching the step, budget or turn limit is an
  intended outcome and costs nothing in reliability; a provider failure or
  timeout is counted, so a run that died on its only turn cannot pass as one that
  completed.

A run that never transitioned scores 100 on safety, because it genuinely spent no
margin. Its evidence states as much — that score records inaction, not safe
operation — and such a run's overall score is a failing grade.

The verdict is computed on demand rather than persisted: it is a pure function of
evidence already stored, so a stored copy could only drift from the data it came
from. `GET /api/simulations/runs/[runId]/evaluation` returns the verdict together
with the raw metric set behind it, authenticated and scoped to the run's owner.

## Persistence

Simulation tables are app-owned. They are created by a forward-only, purely
additive user-owned migration
(`prisma/migrations/20260912000000_add_simulation_tables`); the framework-owned
better-auth migrations and `migration_lock.toml` are untouched.

## Extension points

The contracts leave room for adversarial scenarios, counterfactual transitions,
multi-agent environments, and benchmark suites. New tools must remain
allow-listed and observable; new model providers should implement the adapter
boundary without changing environment or persistence semantics. The evaluation
engine scores whatever the environment persists, so a new environment is scorable
once its evidence is recorded — but a dimension that cannot be derived from
persisted data must be omitted rather than guessed at.

## Legacy surface

The framework's own `ai` module (`src/lib/ai/client.ts`,
`src/app/api/ai/chat/route.ts`) still calls the Polsia AI proxy and reads
`POLSIA_AI_BASE_URL` / `POLSIA_API_KEY` / `POLSIA_API_TOKEN`. It is unrelated to
the Agent Twin and is intentionally left in place; the Agent Twin path does not
import it.
