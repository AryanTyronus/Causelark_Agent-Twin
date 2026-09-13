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
- `src/lib/benchmarks/` owns the benchmark definitions and the arithmetic that
  turns a set of persisted evaluations into an aggregate report. Nine of its ten
  modules are as pure as the two layers above; `execute.ts` is the one declared
  integration seam, and it is the only file in the layer that may import a
  database, an environment variable or the agent runtime (see Benchmarks).
- `src/lib/counterfactual/` owns the counterfactual and causal analysis of a run
  that has already been recorded. Eight of its nine modules are pure folds over
  persisted evidence; `execute.ts` is the one declared integration seam, and it
  reads a run only through the owner-scoped persistence layer and the shared
  evaluation mapping (see Counterfactuals).
- `src/lib/operator/` owns the autonomous operator: the bounds it runs under, the
  tools it may call, the plan it commits to, the readiness methodology and the
  trust report. Six of its nine modules are pure — no database, no provider, no
  clock, no network; `tools.ts` and `run.ts` are the two declared seams, and they
  reach the engines only through the functions the console's own routes call (see
  The operator).
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
  the raw `openai` package.
- Provider selection is `AGENT_PROVIDER`: `bedrock` (default) or `openrouter`.
  It is explicit and never falls back — an unrecognised value fails the turn with
  a visible configuration error rather than quietly running the other provider.
  Because the same bounded Strands agent, the same allow-listed tools, and the
  same validator sit behind both, tool calling, action validation, persistence,
  metrics and replay are provider-independent; only the model client and the
  provider label persisted with each turn differ.
- `AGENT_PROVIDER` is the *deployment's* agent. A caller may instead name a
  selection — a provider this build can serve plus the model it should ask for —
  and the comparison engine does, to run one benchmark against several agents in
  one process. A selection is resolved by the same closed set `AGENT_PROVIDER`
  is checked against, so it can never name a provider this build cannot
  construct a client for; and it carries no credential, because the credential
  and (for Bedrock) the region still come from the environment when the client
  is built. Credentials are deployment configuration, not part of an agent's
  identity. A turn with no selection runs the deployment's own agent, unchanged.
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

## Benchmarks

A benchmark answers a question the single-run layers cannot: *how robust is an
autonomous agent across controlled environmental conditions?* One scenario says
how an agent behaved under one condition; a benchmark runs the same agent across
every condition, scores each run with the existing evaluation engine, and
reports what changed.

The pipeline is:

```
Benchmark definition → Scenario selection → Deterministic run matrix
  → Simulation runs → Persisted evidence → Existing evaluation engine
  → Benchmark aggregation → Robustness report
```

**A benchmark definition is data, never code.** It is an id (lower-kebab), an
integer version, a name, a description, an `environmentKey`, an `objectiveKey`,
an ordered list of `{ id, version }` scenario references, an ordered list of
seeds, and an optional partial configuration override. It carries no function,
no expression and no threshold, so it can be serialised, diffed and compared.
Definitions live in `definitions.ts` and are compiled into a frozen registry in
`catalog.ts`; `getBenchmark(id, version)` resolves against that registry and
throws `UNKNOWN_BENCHMARK` otherwise. There is no filesystem discovery and no
way for a caller to submit a definition — an id supplied through the API can
only ever resolve to a benchmark that shipped with the code. An id that exists
at another version fails with a message naming the version the catalogue does
ship, rather than falling back to it.

`resource-routing-robustness@1` is the shipped benchmark: the `resource-routing`
environment, the `complete-delivery` objective, all seven shipped scenarios at
their pinned version `1`, and one seed (`1042`). One seed is enough to make the
structure and the arithmetic verifiable; the matrix is a cross product, so a
wider seed set is a data change rather than an architectural one.

**The run matrix is the experiment.** `buildRunMatrix` expands scenarios × seeds
with scenarios as the outer loop and seeds as the inner, both in the order the
definition declares them — never in object-iteration order, and a boundary test
asserts the module contains no `Object.keys`/`values`/`entries`. Each cell is
identified by `benchmarkCaseKey(scenarioId, version, seed)` — `"resource-scarcity@1#1042"`
— which is stable regardless of the cell's position, so a case can be matched to
its run without depending on ordering. The matrix is sized to
`MAX_BENCHMARK_CASES = 28` (seven scenarios × `MAX_BENCHMARK_SEEDS = 4`); a
larger definition is refused rather than silently truncated.

**Execution reuses every existing seam.** `executeBenchmark` resolves the
definition, validates each scenario reference through the scenario catalogue,
builds the matrix, and then runs each cell sequentially:

| Step | Existing seam it uses |
| --- | --- |
| Build the perturbed world | `initializeScenarioRun` before the row exists |
| Create the run | the same `SimulationRun` columns and the same `simulation.started` → `scenario.applied` → `observation.created` sequence `POST /api/simulations/runs` writes |
| Advance the agent | `runTurn`, the one bounded turn loop, which claims its own turn and persists its own trace |
| Validate actions | `evaluateSimulationAction`, through the tools, unchanged |
| Score the run | `evaluatePersistedRun`, the same mapping the evaluation endpoint serves |

It creates no second simulation engine, manipulates no simulation state, and
never re-simulates a completed run to produce a number. The benchmark's own
identity is added to the run's `simulation.started` payload (`benchmarkId`,
`benchmarkVersion`, `caseKey`) so a run can be traced back to the experiment that
produced it; no benchmark identity is written into the scenario columns.

**Each case is an independent experiment.** Every cell gets its own run row, its
own seed, its own freshly-initialised world and its own scenario. No mutable
environment object is carried between cases, and the definition is never
mutated. The loop is sequential in this phase — reproducibility matters more than
throughput — but nothing above it assumes that, so a later phase can parallelise
it without changing a contract.

**A failing case does not fail the benchmark.** Each case carries an explicit
status — `COMPLETED`, `LIMIT_REACHED`, `RUNNING`, `TIMEOUT`, `FAILED`, `ERROR`,
`UNAVAILABLE` — which is aggregated three ways: *succeeded*
(`COMPLETED`/`LIMIT_REACHED` — a limit is an intended outcome, matching the
evaluation engine's own rule), *unsuccessful* (`FAILED`/`TIMEOUT`/`ERROR`) and
*unavailable* (`UNAVAILABLE`). A provider failure or a timeout stays visible as
its own count, its own event and its own failure class; it is never converted
into a zero-score success. `RUNNING` is reported as in progress rather than as a
failure it did not record. A case whose evaluation is partial — a timeout — is
still scored, because the evaluation engine's partial semantics are the
authority on what its evidence supports.

### Aggregation

Aggregation is a deterministic fold over the collected `EvaluationResult`s.
Counts are exact. Score averages are computed in integer **hundredths** —
`roundDivide(sum, count, 2)` with half away from zero — so no intermediate value
is ever a float and no rounding happens silently inside a mean. The precision is
the exported constant `BENCHMARK_METRIC_PRECISION = 2`; a value that is not
reported at that precision is not computed at it either.

The report carries `scenarioCount`, `seedCount`, `totalCases`, `completedCases`,
`failedCases`, `timeoutCases`, `errorCases` and `evaluatedCases`, and, over the
evaluated cases only, `averageOverallScore`, `minimumOverallScore`,
`maximumOverallScore` and the five per-dimension averages
(`averageTaskScore`, `averageSafetyScore`, `averageEfficiencyScore`,
`averageResourceScore`, `averageReliabilityScore`). **An absent measurement is
`null`, never `0`** — a dimension no run produced evidence for is reported as
absent, because zero is a score and absence is not one. A `UNAVAILABLE` case
stays counted in the totals and stays out of the averages.

### Robustness

The robustness metric measures **preservation of performance across scenario
changes** — deliberately not the average score. A benchmark whose scores are
uniformly mediocre is not robust; a benchmark that scores well everywhere is.
The metric is versioned `baseline-retention-v1` and its formula is exported as
named logic in `robustness.ts` rather than buried in constants:

```
baselineScore       = mean overall score of the baseline scenario's evaluated cases
scenarioScore       = mean overall score of that scenario's evaluated cases
degradation         = baselineScore − scenarioScore           (absolute)
relativeDegradation = degradation / baselineScore
retention           = scenarioScore / baselineScore           (capped at 1)
robustnessScore     = mean retention over every non-baseline scenario with evidence
```

Three properties are deliberate:

- **Retention is capped at one.** A scenario that scores *better* than the
  baseline is genuinely interesting — it is reported as a negative degradation
  with a negative relative degradation — but it does not let one easy condition
  pay for a collapsed one in the aggregate.
- **The baseline is not averaged into its own metric.** It is the reference, so
  including it would pull every robustness score toward one.
- **A baseline of zero yields no robustness score.** Retention against a zero
  baseline is undefined, so the report states `ZERO_BASELINE` as an explicit
  `unavailableReason` rather than dividing by zero or inventing `1`.
  The other unavailable reasons are `MISSING_BASELINE`,
  `NO_EVALUATED_BASELINE`, `NO_PERTURBED_SCENARIOS` and `NO_EVALUATED_SCENARIOS`.

The report also carries `averageScenarioScore`, `worstScenarioScore`,
`averageDegradation` and `worstDegradation`. **This is Agent Twin's current
deterministic robustness metric. It is not a universal scientific quantity**,
and it is documented as its own definition rather than as a standard measure.

Degradation is additionally broken out per scenario: one row per declared
scenario, in the definition's own scenario order, carrying `scenarioId`,
`scenarioVersion`, `score`, `baselineScore`, `absoluteDegradation`,
`relativeDegradation`, the five dimension scores and `runStatus`. A scenario
that produced no evidence reports `null` scores rather than zeros. The report
names `worstScenario`, `bestNonBaselineScenario` and `greatestDegradation`, and
every tie is broken by the benchmark definition's scenario order — so the answer
is a property of the experiment, not of how a set happened to iterate.

### Failure analysis

Failure analysis counts what the persisted evidence actually supports, in six
classes: `taskFailure`, `safetyViolation`, `invalidActions`, `providerFailures`,
`toolFailures` and `timeouts`. Each class reads one named metric the evaluation
engine already derived from the trace — `objectiveReached`,
`riskThresholdExceeded`, `rejectedAttempts`, `agentErrors`, `failedToolCalls`,
and the run's terminal status respectively — and each finding carries the `runId`
and `caseKey` it came from. There is no LLM, no inference from agent text, and no
causal claim the evidence cannot establish: a case that merely scored badly is
not classified as a failure, and a class with no evidence is reported as zero
rather than left out. The full event trace is not duplicated into the benchmark
result; the result references the runs, and the trace stays where it was
persisted.

### Result contract and persistence

A `BenchmarkResult` is `{ benchmark, configuration, summary, dimensions,
robustness, scenarios, failures, agent }` — the definition's identity, the
scenario/seed/configuration set that actually ran, the aggregate counts and
scores, the robustness report, the per-scenario degradation table and the failure
analysis. It is reported with `BenchmarkResult.parse`, so a malformed report
fails loudly rather than being served.

The result is **a deterministic function of persisted evaluations plus the
benchmark definition** — nothing else. It reads no clock and no randomness; the
only variable is the model's own decisions, which are labelled variable
everywhere else in this document too.

**Nothing about a benchmark is persisted.** No `BenchmarkResult` is stored, and
the schema is unchanged: storing an aggregate would duplicate evidence that is
already in the run rows and let the copy drift from it, exactly as a stored
verdict would. A benchmark's identity survives through the runs it created —
their owner, their scenario, their seed, and the benchmark fields on their
`simulation.started` payload. A benchmark-created run is an ordinary run: it
replays, re-evaluates and reruns through the existing endpoints, and a rerun
still pins the scenario version the original recorded.

### API

| Endpoint | Serves |
| --- | --- |
| `GET /api/benchmarks` | The catalogue as summaries — id, version, name, description, environment key, scenario count — with no modifier internals |
| `POST /api/benchmarks/<benchmarkId>/run` | Executes the benchmark and returns the `BenchmarkResult` |

The run endpoint accepts only an optional `agent` label and an optional `seeds`
list; it carries no scenario, no threshold and no scoring input, and it cannot
submit a definition. It authenticates through the project's own `requireAuth`,
resolves the benchmark from the server-side registry, refuses an unknown id
(`404`), an unknown scenario version (`409`), a seed the environment does not
publish (`400`) and an agent configuration this deployment does not run
(`400`), and creates every run scoped to the signed-in owner. A requested agent
configuration that names a different provider or model is refused rather than
accepted as a label, because a benchmark can only be attributed to the agent that
actually produced its runs. The engine stays provider-agnostic: it never imports
a model client and never branches on which provider is configured, and it names
the deployed configuration by asking the provider boundary once.

## Counterfactuals

A counterfactual answers the two questions the single-run layers cannot: *what
would have happened if the agent had taken a different valid action?* and *how
much did a specific decision contribute to the outcome?* It is a **derived**
statement about a run that already exists — it is never evidence the environment
recorded, and nothing about it is ever written back as if it were.

```
Recorded trace → Decision points → Action space at each point
  → Environment's own transition → Counterfactual continuation
  → Evaluation engine's verdict on both branches → Report
```

**The analysis is computed from three things and nothing else:** the persisted
evidence of a run, the environment's own deterministic transition function, and
the existing evaluation engine's verdict on both the real and the alternative
trajectory. There is no second simulation, no agent run, no model call, and no
score computed in this layer. `src/lib/counterfactual/` names the three
assumptions every number in it is stated under, and carries all three into the
report, because an unexplained *"would have scored 87"* is not a finding:

- **`enumerated-valid-actions-v1`** — *which actions were considered.* The action
  space is **derived, not restated**: the amount range is read back out of
  `SimulationActionInput` by probing it, so a change to the contract moves the
  space with it instead of leaving a copy behind that disagrees. The space is
  ordered by named arrays — type, then resource, then amount — and every
  candidate's verdict is `evaluateSimulationAction`'s, not a re-derivation. A
  `rest` action ignores its resource, so two requests differing only in that
  meaningless field are canonicalised into one alternative.
- **`replay-recorded-attempts-v1`** — *what happens after the intervention.*
  Every attempt the recorded run made after the decision point is re-requested,
  in recorded order, against the counterfactual world, through the same
  validator, and the environment answers each one afresh. A request the altered
  world can no longer satisfy is recorded as refused; one it can now satisfy is
  recorded as accepted. Neither is assumed.
- **`held-constant-non-environment-evidence-v1`** — *what is held equal.* The
  event trace, the tool calls, the budget limit, the turn count and turn budget,
  the initial state and the scenario identity are carried over unchanged. The two
  branches then differ only in the consequences of the choice being examined.

**Refusals are replayed too, including attempts made after the run ended.** Two
consequences of the evaluation engine's design force this. It scores
`rejectedAttempts` as a quantity, so a branch that replayed only the accepted
transitions would be handed a cleaner record than the run it is compared against
— and it would be scored on a run whose agent never made those refusals. And the
runtime demonstrably does record requests made after termination (the environment
answers them `TERMINAL_RUN`), so *"the agent would have stopped"* is an
assumption the evidence contradicts. Replaying the attempt pattern and letting
the environment re-answer keeps the refusal count a property of the choice rather
than an artefact of the policy. A branch that ends the run early therefore
carries the remaining attempts as refusals; `terminatedEarly` says the world
ended before the attempt pattern ran out, and `accepted`/`rejected` are counted
separately so a branch that succeeded early is not silently read as one that kept
working.

**The engine's central correctness property is an identity.** Replaying the
recorded choice as its own alternative reproduces the recorded run exactly —
same world, same terminal status, same attempt pattern, same verdict — differing
only in the branch label on `runId`. This is asserted over every accepted decision
of a real persisted run in the verification harness, and it is the property that
makes every other number credible: an engine that gets the recorded choice wrong
gets every alternative wrong too.

**A branch's terminal status is the environment's answer first.** A branch that
reaches the objective, exhausts its budget or breaches the risk threshold ends
the way the environment says it ends, regardless of how the recorded run
finished. Only when the environment leaves the branch `RUNNING` does a
non-environment ending carry over — a run stopped by its turn budget or by a
provider fault stopped for a reason the intervention could not have changed, so
that ending is held constant along with the rest of the non-environment
evidence. Anything else is a snapshot, reported as `RUNNING`, which is what a
branch the environment never terminated actually is.

**What a report carries, and what it does not.** A dozen decisions produce
hundreds of alternatives, each with its own world and verdict; a report that
carried all of them would be unusable as an answer. So the whole-run report
carries per-decision aggregates — the size of the space, the improving /
equivalent / worsening / uncontested split, the best and worst alternative in
full, the mean, the regret, and at most three outcome-flipping alternatives with
the count behind them — plus the ranking and the critical decision. The full
alternative list, with every counterfactual `SimulationState` and
`EvaluationResult`, is one drill-down away.

**Regret is not a causal claim.** *Regret* is the recorded verdict subtracted
from the best alternative's verdict, and `0` means no alternative the engine
could construct would have scored higher — not that the choice was optimal in any
wider sense. Every generated string is template-derived from those numbers, and
no generated string asserts that a decision caused an outcome; the engine says so
out loud in the modules that could otherwise imply it. Where the engine needs
exact decimal arithmetic it imports the benchmark layer's, rather than growing a
second rounding rule.

**Nothing about an analysis is persisted, and nothing is written.** No
`CounterfactualReport` is stored, the endpoint creates no run, and the analysis
reads its evidence through the owner-scoped `loadRun`. A run that is not the
caller's and a run that does not exist get byte-identical answers, so the endpoint
cannot be used to learn whether someone else's run id exists.

| Endpoint | Serves |
| --- | --- |
| `GET /api/simulations/runs/<runId>/counterfactual` | The whole-run `CounterfactualReport` |
| `GET /api/simulations/runs/<runId>/counterfactual?decision=<index>` | One decision point's `CounterfactualDecisionAnalysis`, with every alternative |

Neither endpoint takes a body: a caller cannot submit evidence, an action space,
a continuation policy or a scoring rule. `?decision=` accepts only a plain,
bounded run of digits — `1.5` and `1abc` are a `400`, not decision 1, because
`Number.parseInt` would silently read them as one. A decision index the run does
not have is a `400`; evidence too large to analyse honestly (more than 64 decision
points) is a `409`, never a silent truncation, because a report that quietly
analysed the first N decisions would read as a statement about the whole run.
`src/lib/business/simulation-evaluation.ts` exposes the persisted-run →
`EvaluationInput` mapping the analysis shares with benchmark execution, so a
benchmark case, an operator-opened run and a counterfactual branch are all
described to the evaluator identically.

## Agent comparisons

A comparison answers one question: **given the exact same environment, benchmark,
scenarios, seeds, constraints, action space, tool surface, objective and
evaluation methodology, which agent configuration behaves better?** It is the
same world run twice with one thing changed, and it is the reason the layers
below it are deterministic at all — a comparison of two agents is only a
statement about the agents if everything else was genuinely held fixed.

The experiment fixes the benchmark and its version, the scenario references and
their versions, the seed set, the matrix and the comparison methodology. The
caller supplies only the agents. Because the benchmark's definition, scenarios,
seeds and objective come from the server-side registry rather than the request,
a caller cannot arrange a comparison in which its favourite agent met an easier
world: the `/run` body is parsed by a schema that strips every key but `agents`
and an optional `seeds`.

**Identity is derived from the fields, never from position.** An agent is
`agentId@agentVersion` on a provider, asking for a model, optionally carrying
metadata. The *name* (`agentId@antecedentVersion`) is what a report shows a
reader; the *configuration key* is what a matrix cell is built from, and it
joins every field through `encodeURIComponent` so no field can impersonate a
separator and two genuinely different configurations cannot collapse into one
column. Agents are sorted by that key, so the order a request listed them in
cannot reach the report. Two configurations sharing one name but differing in
provider or model are refused outright rather than silently disambiguated, and
a repeated configuration is refused rather than reported as two identical
columns.

A case is keyed `agentKey | scenarioId@scenarioVersion#seed`. The matrix nests
the comparison dimension around the benchmark engine's own
`buildRunMatrix`, so the per-agent half is the same builder Phase 3 uses and
there is no second matrix implementation to drift. Reordering the agents,
scenarios or seeds changes no identity and no aggregate — the engine's tests
assert that by rebuilding a report from shuffled inputs and comparing bytes.

**Every run is a fresh, isolated simulation.** Each cell initializes its own
world from the scenario and seed, and drives it through `runTurn` — the same
bounded turn the operator path uses, which claims its own turn, validates every
action through the environment's own validator and persists its own trace. The
agent is chosen in exactly one place: `runTurn` accepts a `selection` (a
provider this build can construct a client for, plus a model) and hands it to
the existing provider boundary. With no selection, the deployment's own agent
runs, which is what every existing caller gets. Nothing bypasses action
validation, no module simulates anything itself, and no environment state is
mutated directly. A comparison is consequently readable through the ordinary
endpoints: agent → benchmark case → simulation run → counterfactual analysis,
because the created runs are ordinary `SimulationRun` rows carrying `agentId`,
`agentVersion`, `benchmarkId`, `benchmarkVersion`, `caseKey` and `seed` in their
`simulation.started` event.

**A credential is deployment configuration, not part of an agent's identity.**
A selection names a provider and a model; the credential and, for Bedrock, the
region still come from the environment when a client is built. That split is
what lets two agents run in one process against one deployment's credentials
without either being able to name, carry or leak the other's. It is also why the
whole engine is testable with no key at all: the unit suite stubs the provider,
the local harness stubs only the model's *choice of tool*, and no test reads,
asserts on or prints an environment variable.

### Aggregation

Each agent's figures are the benchmark engine's own, re-expressed rather than
recomputed: the overall score and the five dimensions, task success and
completion rates, average steps, budget spent and budget utilisation, average
risk, rejected-action rate, provider / tool / timeout failure counts, the
robustness score under `baseline-retention-v1`, and the case counts. A metric
that cannot be derived from the evidence is `null` and stays `null` — an agent
that produced no evidence is not scored as zero anywhere, because "no
measurement" and "measured at zero" are different claims. Robustness is read
from `robustness.robustnessScore` and its formula name is printed beside it: the
comparison does not own a second robustness formula.

Ties are stated as ties. A metric on which every agent agrees names *all* of
them as leaders rather than none, and a neutral metric — steps, budget — names
no leader at all and has no spread, because it has no better direction. Failure
counts line up per class per agent, so a difference in *how* two agents failed is
as visible as a difference in how they scored, and a class the evidence does not
establish is not inferred from it.

### The verdict

The winner is decided by a declared rule — `declared-discriminator-order-v1` —
walked over a declared, ordered list of metrics, and every rung it visited is
recorded in the report with its contenders, its leaders and the value it decided
on. Each rung narrows to the previous rung's leaders, so an agent already behind
cannot win a lower rung. The order descends through the evaluation engine's
dimensions by weight — average overall score, then task, safety, efficiency,
resource and reliability, then robustness. The floor is `INSUFFICIENT_EVIDENCE`,
returned when fewer than two agents produced anything scorable, and a tie at
every rung is reported as `TIE` with `winner: null`.

There is no model in this path. The rule is data, it is deterministic, and it is
arithmetic on the same fixed-point comparison the benchmark engine already uses,
so a report does not depend on a floating-point accident. A comparison adds no
table, no column and no migration: the runs it creates are the evidence, and a
report is a pure function of those rows. Storing a copy could only let it drift
from what it claims to summarise.

| Endpoint | Serves |
| --- | --- |
| `GET /api/agent-comparisons` | The `ExperimentCatalog`: every experiment, its benchmark, its bounds, its methodology |
| `GET /api/agent-comparisons/<comparisonId>` | The `ExperimentPlan` the experiment would run — no agents, no evidence |
| `POST /api/agent-comparisons/<comparisonId>/run` | Runs the comparison and returns the `ComparisonReport` |

Every endpoint requires authentication, scopes its runs to the signed-in owner,
and validates its input with Zod. `/run` refuses zero agents, fewer than two, a
malformed identifier or seed, a duplicate agent, a matrix larger than the engine
will drive, and an agent whose provider this build cannot serve; each maps to an
explicit status — `404`, `400`, `413`, `503` — rather than a silent `500`. A
non-`ComparisonError` is answered with a bare `Internal Server Error`, so a
provider message or a connection string cannot reach a caller.

**A comparison is evidence, not a verdict about agents in general.** Agent Twin
does not claim that a benchmark score proves an agent is universally better. The
result means: *under the defined benchmark and simulated conditions, the observed
agent behavior scored better according to the defined evaluation methodology.*
The provider's own output is allowed to vary between live runs — that is exactly
why the methodology is held fixed and recorded (experiment id and version,
benchmark id and version, agent configurations, scenario ids and versions, seeds,
case counts, completed and failed counts, the robustness formula and the verdict
rule) while the observed results are reported as they were actually observed.
Two agents that miss *different* cases can tie on task success and still be
separated on overall score; the report shows both facts rather than collapsing
them into one number.

## The operator

Everything above is an engine a person drives through a form. The operator is the
same engines driven by an agent, pointed at an objective instead of a form:
*"test this agent and tell me whether it is ready to deploy."*

**The intelligence is orchestration; the truth is not.** The operator decides
*what to do* — which benchmark, which cases, whether a counterfactual is worth
running — and never *what is true*. It cannot score a run, evaluate a case,
compute robustness, rank a counterfactual or choose a verdict, because none of
those operations exists anywhere in its tool surface. Every number it reports is
quoted from an engine that was already here, and every substantive claim carries
the id it came from. That is the whole design of `src/lib/operator/`, and every
other decision in it follows from it.

| Module | Owns |
| --- | --- |
| `config.ts` | The bounds, as constants, with the reason for each value |
| `types.ts` | The request, the run state, the trace step, the plan, the report — all Zod |
| `prompt.ts` | The system prompt: the constraints, stated as constraints |
| `plan.ts` | The plan, its refusals, and the fingerprint over exactly what was authorised |
| `tools.ts` | The tool surface. The one integration seam in the layer |
| `operator.ts` | The Strands `Agent`, its limits, and the stop reason |
| `readiness.ts` | The deployment-readiness methodology, as pure rules over a result |
| `report.ts` | The Agent Trust Report, as a projection of engine output |
| `run.ts` | The server composition: request in, run state out |

Eight of the nine are pure or nearly so: `config`, `types`, `prompt`, `plan`,
`readiness` and `report` reach no database, no provider, no clock and no
network. `tools.ts` and `run.ts` are the declared seams, and they are the only
files in the layer that touch a provider or a database.

### The Strands agent

The agent is constructed in `operator.ts` over the toolbox `tools.ts` builds and
invoked **once**:

```ts
const agent = new Agent({ model, tools, printer: false, toolExecutor: 'sequential', systemPrompt });
const result = await agent.invoke(userPrompt, { limits: { turns }, cancelSignal });
```

There is no `while (the model wants a tool)` loop in the layer, and that is a
requirement rather than a style preference: if the SDK's loop were not what is
doing the orchestrating, what is there would not be a Strands agent. The model
chooses the tools and their order; the SDK runs the loop, executes each tool and
enforces the turn limit; the layer reads `stopReason` back off the result —
`endTurn`, `limitTurns` or `cancelled` — exactly as the simulation agent does.
Cancellation arrives as a result rather than a throw, and an `AbortSignal.timeout`
supplies the wall-clock bound.

`toolExecutor: 'sequential'` is required rather than chosen. The tools share the
request's mutable state — the committed plan, the result slice, the call budget,
the case-evidence counter — so parallel execution would make the recorded order
disagree with the order the model asked in, and the trace is supposed to be a
record of what happened rather than a plausible account of it.

The trace itself is written by a hook: `agent.addHook` observes each
`AfterToolCallEvent`, and the recorder assigns the step's **phase** from a
declared table mapping tool name to phase (`list_agents → discover`,
`create_test_plan → plan`, `run_benchmark → execute`, `inspect_case → inspect`,
`analyze_counterfactual → analyze`, `generate_trust_report → report`). The phases
in the interface are therefore a record of which tools ran, not a story the model
tells about its own process. Nothing the model *says* enters the trace; narration
is held in a separate, size-capped field.

The model comes from the **existing** provider boundary — `createAgentModelFor`,
the same function the simulation agent and the comparison engine use. The layer
adds no provider, no client, no credential handling and no new environment
variable. `AGENT_PROVIDER` selects Bedrock or OpenRouter exactly as it does
everywhere else, and the operator fails the same way every other agent path fails
when the selected provider is unconfigured.

### The tool surface

Ten tools. Each is an adapter: it validates its arguments with Zod, calls one
function that already exists in this codebase, reduces the answer to something a
model can read and a person can scan, and records what happened.

    READ    list_agents, list_benchmarks, get_benchmark,
            inspect_results, inspect_case, replay_case, analyze_counterfactual
    ACTION  create_test_plan, run_benchmark, generate_trust_report

The split is by what a call can change. `create_test_plan` writes nothing outside
the run's own memory; `run_benchmark` spends provider capacity; `generate_trust_report`
assembles a projection of what was already recorded. Everything else only reads.

**What is absent is as load-bearing as what is present.** There is no shell, no
filesystem, no arbitrary HTTP, no SQL and no query builder — no generic
`query_database()`, and no tool that takes a path, a command, a URL or a
statement as an argument, so a model that asks for one is refused by the absence
of the tool itself rather than by a check inside it. There is no environment
inspection: `list_agents` reports that a provider *is configured* without ever
touching the value that configures it, and no tool result contains a credential.
And there is **no owner parameter anywhere**: identity is captured in the tool
closures from the authenticated session, because a tool input that could name a
user is a tool input that could name someone else's.

**Tool output is data.** A tool result is handed to the model as text and nothing
more. It cannot add a tool to the surface, change a tool's schema, redefine a
permission or alter the bounds — the surface is built once, before the first
model call, and the model is offered the same list on every turn. A benchmark
whose *name* carries instructions to the model is therefore carried through as a
string in a result, and the run that follows it is the run the script asked for.

**A run id is not a capability.** `inspect_case`, `replay_case` and
`analyze_counterfactual` take a run id, and each resolves it against the result
*this* execution produced before it touches the database. A run id the model
invents, or one it read from somewhere else, is refused before a query is issued.
The read that then happens is owner-scoped again through the ordinary persistence
layer, so the ownership boundary is enforced twice rather than assumed once.

### Authorisation

The request contract has no owner field, and `POST /api/operator` resolves the
account from the session with `requireAuth`. That id is the only identity any
tool ever receives. There is consequently no body a caller can send, and no
sentence a model can write, that names a different account — a user cannot use
the operator to reach another user's agents, simulations, experiments, reports or
evidence, because every tool that could is constructed per-request around one
owner and re-scopes every read it performs.

An execution is authorised separately from a plan. `create_test_plan` returns a
fingerprint over exactly the fields that define what will run — benchmark id and
version, agent key, seeds, and scenario ids with their versions, in the registry's
own order — and `run_benchmark` refuses unless the caller presents that
fingerprint back. The comparison is made server-side against a plan the server
builds from the same request, so the check is not "does this string look right"
but "is the plan the person approved the plan this deployment would run now". A
drift in any covered field produces a different digest and therefore a refusal.

### Bounds

The operator's entire allowance is eleven constants in `config.ts`. None is read
from a request, and each is enforced inside a tool closure rather than left to
the model's judgement about when to stop — a model that ignores every instruction
still cannot exceed them, because the code that would do the work refuses and
returns the refusal to the model as a result.

| Bound | Value | Enforced by |
| --- | --- | --- |
| `MAX_TURNS` | 12 | `invoke({ limits: { turns } })` — the SDK's own loop |
| `MAX_TOOL_CALLS` | 24 | The call counter inside the toolbox, across every turn |
| `MAX_BENCHMARK_RUNS` | 1 | `run_benchmark`, which refuses a second execution |
| `MAX_COUNTERFACTUAL_ANALYSES` | 3 | `analyze_counterfactual`, which refuses a fourth |
| `MAX_DURATION_MS` | 180 000 | `AbortSignal.timeout`, read back as a stop reason |
| `MAX_CASE_EVIDENCE` | 6 | `inspect_case`, bounded separately from the call budget |
| `MAX_TRACE_STEPS` | 60 | The trace recorder; the truncation is written into the notices |
| `MAX_REJECTED_ACTIONS` | 8 | How many rejections a case quotes; the counts stay exact |
| `MAX_TRACE_DETAIL_BYTES` | 2 048 | How much of a tool result the trace retains |
| `MAX_NARRATION_CHARS` / `MAX_INTERPRETATION_CHARS` | 2 000 / 1 200 | What the model may write into the state |

Each value is documented where it lives with the reason it is what it is. The two
that carry the most weight are turn and tool-call budgets: a model that wanted to
read all seven cases individually would exhaust the call budget, which is the
point — choosing which cases are worth reading is the judgement the operator is
for. Hitting a bound is a reported outcome, not a hidden one: the run state
carries the stop reason and the usage, and a run that ran out of turns says so.

### Planning, and what may not be invented

`plan.ts` builds the plan, and every field is copied from the benchmark registry
or the agent catalogue: id, version, name, environment key, objective key, the
scenario references with their versions, and the declared seeds. None of those is
a tool input. A model can choose *which* benchmark and *which* agent; it cannot
supply a scenario, a seed, a scoring formula, a threshold or a version.

Refusals name what actually exists — the registered benchmark ids, the catalogue
keys, the declared seeds — so a model that guesses can correct itself on the next
turn instead of improvising. When the objective cannot be settled by a benchmark
this build registers, or no agent in the catalogue resolves, the instructed and
correct outcome is to say so and stop. Nothing silently substitutes an agent, and
no plan is built from a benchmark that is not in the compiled registry.

### The result slice, and why the bulk is left out

`inspect_results` returns a **projection** of the benchmark result: the case
counts, the scored dimensions, the robustness report, the per-scenario rows, the
failure classification, and the run ids in matrix order. The per-case evaluations
are deliberately absent. Inspecting a case is a decision the operator makes and a
call it spends, not something that arrives whether it was wanted or not — which is
also what makes the case-evidence bound meaningful. `inspect_case`, `replay_case`
and `analyze_counterfactual` are then thin adapters over `evaluatePersistedRun`,
`buildSimulationReplay` and `analyzePersistedCounterfactual`, the same functions
the console's own pages call.

### The readiness methodology

`readiness.ts` computes the verdict from the slice. It is a pure function of
engine output, so the same result always produces the same verdict, and the
methodology is named and published: `observed-evidence-thresholds-v1`.

Rules are graded four ways over a **nullable** measurement — `pass`, `caution`,
`fail`, or `insufficient` when the measurement does not exist. An absent
measurement is never a zero and never a pass. Two rules are decisive: a recorded
risk-limit violation, and the absence of any evaluation at all. The precedence is
fixed:

    decisive fail        → NOT_READY
    decisive insufficient→ INSUFFICIENT_EVIDENCE
    any fail             → NOT_READY
    any insufficient     → INSUFFICIENT_EVIDENCE
    any caution          → CAUTION
    otherwise            → READY

Thresholds sit on the evaluation engine's own 0–100 scale and the benchmark
engine's own 0–1 retention scale, and each is documented in the file with the
reason it is where it is: overall 75/55, task success 70/50, safety 85/70,
robustness 0.85/0.70, reliability 70/50. None is claimed to be a scientific
constant. They are published so a deployment can argue with them rather than
guess at them, and the report echoes every threshold beside the figure it graded
so a reader can recompute the verdict by hand.

**There is no universal "good enough" score**, and the layer does not pretend
otherwise: the methodology says what it is, the report names it, and a rule that
could not see its measurement says `insufficient` rather than passing quietly.
`INSUFFICIENT_EVIDENCE` is a real answer here, not a failure to produce one.

### The report

`report.ts` assembles the Agent Trust Report, in three registers that are kept
apart:

- **Observed** — the benchmark's own figures, quoted. Scores, dimensions,
  robustness with its formula name, the scenario table, the failure classes with
  their counts and the runs behind them.
- **Verdict** — the methodology's, with every rule's threshold, observed value,
  outcome, decisive flag and evidence references.
- **Interpretation** — the model's reading of the evidence, in its own words,
  in its own field, capped in length and labelled as its reading. It appears
  nowhere in `observed` and nowhere in `verdict`.

The report also carries its provenance: the plan's fingerprint, the run ids, the
scenario ids, and the names of the policies the counterfactual findings were
produced under — `readiness method`, `robustness formula`, and
`counterfactual <policy>`. Every `decisionId` in a counterfactual finding begins
with the run id it came from.

### No persistence, no credentials

The operator adds no table, no column, no migration and no cache. Its run state
is request-scoped and ephemeral, returned to the caller and then gone; the
`SimulationRun` rows it caused remain the evidence layer, exactly as they are for
a benchmark or a comparison run made by hand. Nothing here needed to be stored:
the report is a projection of rows that already exist, and a stored copy could
only drift from them. Migrations are unchanged by this phase.

No credential reaches the model, the trace, the report or the response body. The
provider boundary resolves credentials from the deployment's environment when a
client is built, as it does for every other agent path; the operator never sees
them, no tool can return them, and the run state is asserted in the verification
harness to contain no key material.

### The test seam

`runOperator` accepts an optional `model`. Production omits it and the
deployment's configured provider is used. A test supplies a scripted `Model` — a
subclass of the SDK's own abstract class, emitting the real streaming protocol in
the real order — and in doing so replaces the one thing that is neither
deterministic nor free: which tool the model chooses to call. The real agent
loop, the real tool surface, the real hooks, the real engines and the real
database all run unchanged.

That seam is also what lets the adversarial suite exist. A model that asks for
`query_database`, a shell, a URL or an environment variable; a model that names
another account's run id; a model that repeats the same call forever; a model
that sends malformed arguments to every tool — each is driven through the real
surface and refused by it.

### API

| Endpoint | Serves |
| --- | --- |
| `POST /api/operator` | One operator request: `{ objective, mode, agentKey?, authorizedPlanFingerprint? }` → the `OperatorRunState` |

The handler authenticates with `requireAuth`, validates the body with Zod
(`INVALID_REQUEST` on failure), and maps its own error codes onto statuses —
`NO_AGENT_CONFIGURED` and `PROVIDER_UNAVAILABLE` to `503`, `OPERATOR_FAILED` to
`500`. A run that produced findings is a `200` even when the findings are bad: a
benchmark whose cases failed is a result, and dressing it as an error status
would tell a caller their request was malformed when what happened is that their
agent did badly. An unexpected throw is answered with a fixed sentence rather
than the thrown message, because that response is served to whoever is signed in.

## The console

Everything above is a domain engine. The console is the surface over them, and it
is deliberately thin: it renders what a server route returned and recomputes
nothing. There is no second implementation of the overall score, the robustness
retention, the failure taxonomy, the counterfactual regret or the verdict rule in
`src/components/custom/agent-twin/**` or in `src/app/(dashboard)/dashboard/**`. If
a number appears on a console page, it arrived in a response body.

That is a rule with teeth, because it is the only thing keeping the console honest
about the engines' own distinctions. An agent that produced no evidence has a
`null` metric; a console that recomputed anything would be tempted to coerce it to
`0`, and "scored zero" and "not measured" would become the same claim on screen.
So a metric with no evidence renders as `unavailable`, a run with no recorded
scenario renders as `not recorded`, and a comparison whose evidence could not
discriminate renders the engine's own `INSUFFICIENT_EVIDENCE` rather than a
weaker-sounding "no winner".

**Three registers, kept apart.** A console page distinguishes what the evaluation
engine measured, what the scenario engine applied, what the trace recorded, and
what the counterfactual engine concluded — and names the engine where a reader
could otherwise attribute one to another. The counterfactual page in particular
shows only conclusions the counterfactual engine returned; no model explains a
result to the reader, and none is asked to.

**A comparison report is not persisted.** `POST
/api/agent-comparisons/<id>/run` returns the report, and the console holds it in
the browser for the session that ran it — `sessionStorage`, stated on the page as
such. The runs the report was derived from *are* persisted, they are listed
alongside it, and the report is reproducible from them, which is the same argument
the comparison layer makes for not caching it: a stored copy could only drift from
the evidence it claims to summarise. The consequence is stated on the page rather
than hidden — a comparison result is shown only in the browser session that made
it, and opening the page elsewhere reports what it has: the registration and the
runs, and no verdict.

**The run experience is not simulated.** A comparison executes a real matrix
through the ordinary turn path, so the console has no progress to report until the
server has something to report. It polls the persisted runs and shows the ones
that exist; it does not draw a progress bar over a duration it guessed. There is no
fabricated execution event anywhere in the console, because a run that reported
progress it had not made would be the one thing this product cannot afford.

**The benchmark detail endpoint.** `GET /api/benchmarks/<benchmarkId>` is the one
route added for this surface. It projects the compiled registry through the same
`findBenchmark` the execution path uses, so the benchmark a page describes is the
benchmark that would run — a page cannot advertise a definition that execution
would not resolve. The version is validated (`/^\d{1,6}$/`) and an unknown id is a
`404` with `code: "UNKNOWN_BENCHMARK"`; the caller's own input is not echoed back
into the message. It is a `GET` over a frozen, in-process registry: it reads no
database, takes no input beyond the id and version, and returns no credential.

| Console route | Engine surface it renders |
| --- | --- |
| `/dashboard` | Recorded runs, the benchmark catalogue, the experiment catalogue |
| `/dashboard/tests`, `/dashboard/tests/<id>` | The experiment registration, the persisted runs, and the session's report |
| `/dashboard/benchmarks`, `/dashboard/benchmarks/<id>` | The benchmark catalogue and one pinned definition |
| `/dashboard/agents` | The agent configurations this build can construct a client for |
| `/dashboard/simulations`, `/dashboard/simulations/<id>` | The run starter, the inspector, the trace and the replay |
| `/dashboard/operator` | The operator request, its live tool trace, the committed plan, the trust report and the run ids behind it |
| `/dashboard/docs` | The methodology, as prose about the engines above |

The console is a client over authenticated routes; it adds no route of its own
beyond the benchmark detail projection, no table, no column and no migration. An
`apiFetch` failure renders as an explicit unavailable state with the endpoint's
status kept out of the page, and an unreadable catalogue is never rendered as an
empty one — a deployment whose database is down must not look like a deployment
with no tests.

## Persistence

Simulation tables are app-owned. They are created by forward-only, purely
additive user-owned migrations
(`prisma/migrations/20260912000000_add_simulation_tables`, then
`prisma/migrations/20260913000000_add_scenario_identity`, which adds the two
nullable scenario columns to `SimulationRun`); the framework-owned better-auth
migrations and `migration_lock.toml` are untouched. The benchmark layer adds no
migration at all: it stores nothing of its own, and the runs it creates are
ordinary runs in the tables above. The counterfactual layer adds no migration and
no column either: it stores nothing, and it analyses an existing trace through
`loadRun`, reading exactly the tables a replay and an evaluation already read. The
comparison layer likewise adds no migration, no table and no column: a comparison
report is computed on demand from the `SimulationRun` rows it created, which are
ordinary runs carrying their agent attribution in the `simulation.started` event
payload. Caching a report would introduce a second copy of the evidence that
could disagree with it. The operator layer is the same story again: no migration,
no table, no column and no cache. Its run state exists for the duration of one
request and is returned to the caller; the runs it caused are ordinary
`SimulationRun` rows, and the report is a projection of them.

## Extension points

New tools must remain allow-listed and observable; new model providers should
implement the adapter boundary without changing environment or persistence
semantics. The evaluation engine scores whatever the environment persists, so a
new environment is scorable once its evidence is recorded — but a dimension that
cannot be derived from persisted data must be omitted rather than guessed at.
New environmental conditions belong in the scenario catalogue as declarative
modifiers over the environment's published constants, not as special cases inside
the environment or the agent runtime. New benchmarks belong in the benchmark
definition list as data — an environment, an objective, scenario references and
seeds — and a new *kind* of robustness metric belongs as a new named formula
beside `baseline-retention-v1`, versioned and documented, rather than as a change
to what the existing one means. A new continuation assumption belongs as a new
named, versioned policy in the counterfactual layer, stated in the report
alongside the one it replaces — never as a change to what
`replay-recorded-attempts-v1` means, because two reports that name the same
policy must be comparable. A new *comparison experiment* belongs in the
comparison layer's definition list as data — a benchmark reference, a
methodology, a verdict rule and its bounds — never as a branch inside the
aggregation; and a change to the verdict order is a change to what
`declared-discriminator-order-v1` means, so it arrives as a new named rule
rather than as an edit that would silently reinterpret every report already
produced under the old one. A new *operator tool* belongs in `tools.ts` as a
thin adapter over a function that already exists, declared in `TOOL_PHASES`,
given a Zod input schema and, if it can change anything, counted against a bound
in `config.ts` — never as a second implementation of a calculation the engines
own, and never with a parameter that names an owner. A change to what a rule
grades or where a threshold sits is a change to what
`observed-evidence-thresholds-v1` means, so it arrives as a new named methodology
rather than as an edit under the old name.
