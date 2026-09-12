# Causelark Agent Twin architecture

Causelark treats the environment as a deterministic, inspectable boundary. A
run starts with a validated configuration and seed, persists its observable
initial state, and advances through a request-driven `agent-step` endpoint.

## Boundaries

- The pure resource environment in `src/lib/business/simulation.ts` owns state,
  permissions, budget, task requirements, validation, rejection reasons, and
  terminal status. It has no database or provider imports.
- `src/lib/agent/provider.ts` is the replaceable provider boundary. The current
  runtime uses the official Strands Agents TypeScript SDK's OpenAI-compatible
  model adapter pointed at the Polsia AI proxy (`POLSIA_AI_BASE_URL` and
  `POLSIA_API_KEY`). It does not call Amazon Bedrock, a direct model-vendor
  endpoint, or customer AWS credentials. The proxy chooses the underlying
  model.
- `resource-tools.ts` exposes only `observe_resources` and `request_action`.
  Tool inputs are schema-validated, and every result passes through the same
  deterministic environment validator as the manual operator path.
- `run-turn.ts` claims one run turn, invokes the agent, persists tool calls,
  actions, state changes, safe provider metadata, errors, and terminal events,
  then releases the claim. There is no in-process worker loop.
- API handlers are the security boundary. They authenticate and scope every
  read/write to the signed-in owner. Client islands read only through typed
  `apiFetch` contracts.

## Observable trace

The trace stores simulation start, observations, turn metadata, tool request and
result records, action validation or rejection, state-change diffs, task
progress, errors, and terminal outcome. It never stores prompts, hidden state,
private chain-of-thought, or raw provider reasoning. Metrics are calculated from
persisted actions/events, and replay frames are reconstructed from persisted
state transitions.

## Determinism and failure states

The same environment configuration and seed produce the same initial state and
transition results. The provider decision path is intentionally labelled
variable: a same-seed rerun proves environment determinism, not identical model
choices. Missing proxy configuration, malformed tool calls, provider errors,
timeouts, invalid actions, concurrency conflicts, and terminal limits become
persisted recovery/failure states rather than silent browser errors.

## Extension points

The contracts leave room for adversarial scenarios, counterfactual transitions,
safety evaluations, multi-agent environments, and benchmark suites. New tools
must remain allow-listed and observable; new model providers should implement
the adapter boundary without changing environment or persistence semantics.
