# Causelark Agent Twin architecture

Causelark treats the environment as a deterministic, inspectable boundary. A
run starts with a validated configuration and seed, persists its observable
initial state, and advances through a request-driven `agent-step` endpoint. It
can instead start inside a **scenario** — a declarative, deterministic
perturbation of that baseline, applied before the run exists (see Scenarios).

## Boundaries

- The pure resource environment in `src/lib/business/simulation.ts` owns state,
  permissions, budget, task requirements, validation, rejection reasons, and
  terminal status. It has no database or provider imports.
- `src/lib/scenarios/` owns the environmental conditions a run can be started
  under. It is data plus pure functions — no database, provider, clock,
  randomness or filesystem access — and it modifies a world only by returning a
  new one, through the environment's own contracts and constants.
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

## Scenarios

A scenario is a deterministic environmental condition: the same agent, in the
same environment, evaluated under a controlled perturbation of it. The pipeline
is baseline environment → scenario definition → deterministic modification →
agent run → persisted evidence → the existing evaluation engine, and the question
it answers is *"how does this agent behave when the environment changes?"*.

`src/lib/scenarios/` holds the whole layer, and it is isomorphic — Zod and the
domain contracts, plus the environment's own published constants. Like the
evaluation engine, it has no database, provider, clock, `server-only` or
filesystem access, so it runs identically in a route handler and in a unit test:

| File | Holds |
| --- | --- |
| `types.ts` | The scenario, modifier, change-record and result contracts |
| `modifiers.ts` | One pure applier per modifier kind, in an exhaustive table |
| `definitions.ts` | The seven shipped scenarios and the constants they derive from |
| `catalog.ts` | The frozen catalogue and typed lookup by id and version |
| `apply.ts` | `applyScenario`: validate, copy, apply in order, validate, report |
| `scenario.ts` | The seam run creation uses: `initializeScenarioRun` |

**A scenario is data, never code.** It is an id, a name, a description, an
integer version and an ordered list of modifiers, each a tagged record of
parameters drawn from a closed vocabulary of six kinds: `resource-reduction`,
`resource-outage`, `budget-reduction`, `risk-increase`, `max-steps-reduction`
and `permission-revocation`. Application is a pure function per kind; a
definition can carry no other kind and no expression, so an id supplied through
the API can only ever resolve to a definition that shipped with the code. The
catalogue is a typed registry, not filesystem discovery, and an unknown id — or a
recorded version the catalogue no longer ships — fails with
`UNKNOWN_SCENARIO` rather than falling back to something close.

**Determinism is structural.** The module reads no clock, no randomness and no
environment variable, and a boundary test asserts it by reading the module's own
source. Versions are small integers rather than timestamps, and they identify a
definition, so a run recorded as `resource-scarcity@1` still resolves to exactly
the world that produced it. The seed is preserved: `applyScenario` re-reads it
after applying every modifier and refuses a result that changed it, because the
seed belongs to the run, not to the condition. Definitions are frozen, and
`applyScenario` never mutates its input — it re-parses the baseline and each
modified world through the contracts and builds new objects.

**Every change is explicit and attributable.** `applyScenario` returns the
modified state and configuration alongside a change record per field it touched:
`{ field, before, after, modifier }`, with the scenario id and version carried
alongside. That is what answers what the original value was, what it became,
which modifier moved it, and which scenario version is responsible — for example
`{"field":"budgetRemaining","before":24,"after":14,"modifier":"budget-reduction"}`.
A modifier that does not actually move a value emits no record. Reductions
saturate at named floors (`MIN_SCENARIO_RESOURCE`, `MIN_SCENARIO_BUDGET`,
`MIN_SCENARIO_MAX_STEPS`, `SCARCITY_RESOURCE_FLOOR`) rather than failing, and the
saturated record shows the real numbers; risk elevation is the deliberate
exception — it does not saturate, so an elevation that would reach the failure
threshold is refused instead of being silently trimmed.

The shipped scenarios are versioned definitions over the environment's own
constants rather than invented numbers: scarcity halves each resource's published
`startingRange` minimum, budget pressure removes a declared share of
`DEFAULT_CONFIGURATION.budget`, and the tight step limit halves
`DEFAULT_CONFIGURATION.maxSteps`.

| Scenario | What it changes |
| --- | --- |
| `baseline` | Nothing — the control condition, recorded explicitly |
| `resource-scarcity` | Reduces energy, materials and water at their starting stock |
| `budget-pressure` | Reduces the run's budget, in both state and configuration |
| `elevated-risk` | Raises starting risk, never past the environment's maximum |
| `resource-outage` | Puts one resource at zero and publishes the outage as a constraint |
| `tight-step-limit` | Halves the step limit, in both state and configuration |
| `action-rejection` | Revokes one action type, in the environment's own permission list |

**Safety, not special-casing.** Application happens before the run exists, at
initialisation, so the agent starts inside the condition and cannot act before it
is in force. Nothing bypasses validation: the action-rejection scenario removes an
entry from the environment's permission list, and the refusal the agent sees is
the environment's ordinary `PERMISSION_DENIED`, produced by
`evaluateSimulationAction`. The scenario layer holds no rejection vocabulary of
its own, and a boundary test asserts that. The outage likewise publishes a
constraint instead of teaching the environment about outages.

**Persistence records the condition, not the perturbation.** A run stores
`scenarioId` and `scenarioVersion` — two additive nullable columns — and its
`state` already holds the world the run started in, so the perturbed world is not
duplicated and no derived value is stored twice. The pre-scenario numbers survive
in the `scenario.applied` event payload, which is where an auditor wants them. A
rerun pins the version the original recorded rather than re-resolving the id
against the current catalogue, so a later change to a definition cannot silently
change what reproducing a run means.

**Evidence.** Applying a scenario is an environment event, not an agent action:
it is written as a `scenario.applied` event with `source: 'system'`, sequenced
between `simulation.started` and the first `observation.created`, and no
simulation action is recorded for it. An unscenarioed run writes exactly the
events it wrote before this layer existed.

`GET /api/scenarios` serves the catalogue as summaries — id, name, description,
version — with no modifier internals. Run creation accepts an optional
`scenarioId`, resolved through the catalogue, and `POST
/api/simulations/runs/<runId>/rerun` replays the recorded condition.

Evaluation carries the scenario as **context, not input**: the verdict for the
same evidence is identical whether or not a scenario is attached, and the
metadata exists so a score can be labelled with the condition it was measured
under. Phase 2 adds no scenario-specific scoring and no robustness score.

## Persistence

Simulation tables are app-owned. They are created by forward-only, purely
additive user-owned migrations
(`prisma/migrations/20260912000000_add_simulation_tables`, then
`prisma/migrations/20260913000000_add_scenario_identity`, which adds the two
nullable scenario columns to `SimulationRun`); the framework-owned better-auth
migrations and `migration_lock.toml` are untouched.

## Extension points

New tools must remain allow-listed and observable; new model providers should
implement the adapter boundary without changing environment or persistence
semantics. The evaluation engine scores whatever the environment persists, so a
new environment is scorable once its evidence is recorded — but a dimension that
cannot be derived from persisted data must be omitted rather than guessed at.
New environmental conditions belong in the scenario catalogue as declarative
modifiers over the environment's published constants, not as special cases inside
the environment or the agent runtime.

## Legacy surface

The framework's own `ai` module (`src/lib/ai/client.ts`,
`src/app/api/ai/chat/route.ts`) still calls the Polsia AI proxy and reads
`POLSIA_AI_BASE_URL` / `POLSIA_API_KEY` / `POLSIA_API_TOKEN`. It is unrelated to
the Agent Twin and is intentionally left in place; the Agent Twin path does not
import it.
