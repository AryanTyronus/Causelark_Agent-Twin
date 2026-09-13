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
`loadRun`, reading exactly the tables a replay and an evaluation already read.

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
policy must be comparable.

## Legacy surface

The framework's own `ai` module (`src/lib/ai/client.ts`,
`src/app/api/ai/chat/route.ts`) still calls the Polsia AI proxy and reads
`POLSIA_AI_BASE_URL` / `POLSIA_API_KEY` / `POLSIA_API_TOKEN`. It is unrelated to
the Agent Twin and is intentionally left in place; the Agent Twin path does not
import it.
