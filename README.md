# Causelark Agent Twin

**Test autonomous intelligence before it touches the real world.**

Causelark is a crash-test facility for autonomous AI agents.

**Agent Twin** puts autonomous agents inside controlled digital environments, stress-tests them under changing conditions, records the evidence behind every decision, and measures how they actually behave.

The idea is simple:

> **Before you give an AI agent access to the real world, give it a digital twin.**

Instead of deploying an agent and discovering its failure modes in production, Agent Twin gives it a deterministic environment where failure is safe, observable, reproducible, and measurable.

## Why Agent Twin?

Autonomous agents are increasingly being trusted to make decisions and take actions: allocating resources, operating systems, spending budgets, and responding to changing conditions.

The problem is that success on one happy-path run tells you very little about how an agent behaves when the environment changes.

Agent Twin tests the agent under controlled conditions.

It answers questions such as:

- Does the agent actually complete its objective?
- Does it respect safety and resource constraints?
- What happens when resources become scarce?
- What happens when a resource becomes unavailable?
- How does it behave under budget pressure or tighter step limits?
- Does it make invalid or rejected actions?
- Can a failure be reproduced?
- Which decision actually contributed to a poor outcome?
- Which agent performs better when two agents face the exact same world?
- Is there enough evidence to trust the agent for deployment?

The key principle is:

**The model produces decisions. The environment produces truth.**

---

## How It Works

```text
                    HUMAN
                      │
              "Test this agent"
                      │
                      ▼
            ┌───────────────────┐
            │ Agent Twin        │
            │ Operator          │
            │ (Strands Agent)   │
            └─────────┬─────────┘
                      │
                tool-driven
                orchestration
                      │
                      ▼
            ┌───────────────────┐
            │ Benchmark Engine  │
            └─────────┬─────────┘
                      │
                      ▼
Environment → Observation → Agent Decision
                  ▲              │
                  │              ▼
                  │       Action Validation
                  │              │
                  │              ▼
                  └──── State Transition
                         │
                         ▼
                    New State
                         │
                         ▼
              Evaluation / Replay
                         │
                         ▼
               Evidence / Report
                         │
                         ▼
                      HUMAN
```

---

## Core Technical Engines

### 1. Deterministic Digital Environments
The simulation is a pure state transition function with no clocks, I/O, or ambient randomness. Given a seed and a sequence of actions, the world transitions to the exact same state every time.
*   **Resource Routing (`resource-routing`)**: Optimizes water, energy, and material distribution under capacity, risk, and budget limits.
*   **$10K Trading Challenge (`trading-10k`)**: Implements market-making portfolio simulations. It is fully implemented as an offline benchmark, though its live production execution encountered an environment issue.

### 2. Guarded Action Validation
The agent can only observe state and request actions. Every action is evaluated by `evaluateSimulationAction` before changing state. If the action is illegal (e.g. `BUDGET_EXCEEDED`, `RESOURCE_REQUIRED`), it is immediately rejected, recorded as a validity fault, and the environment state remains completely unaffected.

### 3. PostgreSQL Event Sourcing & Replay
High-fidelity traces persist every step (`agent.turn.started` → `observation.created` → `action.validated`/`rejected` → `state.changed`). The frontend reconstructs these traces frame-by-frame, enabling step-by-step visual debugging.

### 4. Isomorphic Mathematical Evaluation
Run evaluation is a pure fold over persisted evidence (the trace). It reads no clock or LLM judge, making it entirely deterministic and reproducible—evaluating the same run twice returns deep-equal metrics across 5 dimensions: **Task Success (30%)**, **Safety (25%)**, **Efficiency (15%)**, **Resource Management (15%)**, and **Reliability (15%)**.

### 5. Declarative Scenario Perturbations
Scenarios are purely data-driven modifiers (e.g., `resource-scarcity`, `elevated-risk`) that apply controlled environmental stress before a run starts, without altering validation logic.

### 6. Benchmark Matrices & Agent Comparison
Benchmarks run a matrix of scenarios × seeds to measure robustness degradation. The Comparison Engine executes multiple agents under isolated parallel environments with identical seeds, determining head-to-head performance using a deterministic discriminator cascade.

### 7. Counterfactual Causal Analysis
By analyzing decision points along a trace, the Counterfactual Engine calculates step-level "regret" by simulating alternative actions and their expected state transitions, isolating precisely which decisions compromised the run.

---

## The Operator (Strands Agent)

The Operator is a **real autonomous agent** built on the **Strands Agents TypeScript SDK**—not a hardcoded chatbot. It is pointed at a high-level goal: *"Test this agent and tell me whether it is ready to deploy."*

*   **Bounded Autonomy:** Execution is governed by strict, code-enforced limits (max 12 turns, 24 tool calls) to prevent runaway model behavior.
*   **Secure Tool Surface:** Implements 10 read/action tools with zero filesystem, database, shell, or network access.
*   **Evidence-First Reports:** Aggregates run metrics, analyzes worst-case degradation, runs counterfactuals, and maps results to a formal readiness verdict (`READY`, `CAUTION`, `NOT_READY`, `INSUFFICIENT_EVIDENCE`) under `observed-evidence-thresholds-v1`.

---

## Model Providers & AWS Bedrock Support

The agent runtime uses a strict, non-falling-back provider boundary:

*   **Amazon Bedrock (Default / Production):** Integrates using the standard `@aws-sdk/client-bedrock-runtime` to drive the Amazon Bedrock Converse API. Validated and demonstrated end-to-end against Bedrock with **Amazon Nova Pro** (default Bedrock model) and **Mistral Large 3**.
*   **OpenRouter (Development Only):** Points to OpenRouter's OpenAI-compatible endpoint for local development without credentials.

AWS credentials are resolved securely via the standard SDK credential chain. Provider errors are mapped to safe, classified failure codes (`access_denied`, `throttled`, etc.) without exposing raw payloads or API keys.

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| **Agent Framework** | Strands Agents TypeScript SDK 1.17 |
| **Model Providers** | Amazon Bedrock (Converse API) · OpenRouter |
| **Application** | Next.js 16.2 (App Router, Turbopack), React 19.2 |
| **Language** | TypeScript 5.5, strict, `noUncheckedIndexedAccess` |
| **Contracts** | Zod 4 |
| **Database** | PostgreSQL via Prisma 6.19 |
| **Auth** | better-auth 1.6 |
| **UI** | Tailwind CSS 4.3, Radix UI primitives, shadcn-style components |
| **Code Quality** | Biome 2.3 (Lint & Format), Vitest 3.2 |

---

## Getting Started

### Prerequisites
- Node.js ≥ 22 (pinned in `.nvmrc`)
- PostgreSQL

### Installation & Run

1. **Install dependencies:**
   ```bash
   npm ci
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env.local
   # Configure DATABASE_URL, BETTER_AUTH_SECRET, and BEDROCK_MODEL_ID or OPENROUTER_API_KEY
   ```

3. **Deploy migrations:**
   ```bash
   npm run db:migrate:deploy
   ```

4. **Launch development server:**
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000` to access the dashboard console.

---

## Environment Variables

See `.env.example` for the authoritative template.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string for Prisma |
| `BETTER_AUTH_SECRET` | Yes | Session signing secret |
| `AGENT_PROVIDER` | No | `bedrock` (default) or `openrouter` |
| `BEDROCK_MODEL_ID` | For Bedrock | Model or inference profile ID (e.g. `amazon.nova-pro-v1:0`) |
| `BEDROCK_REGION` | No | Target AWS region; falls back to `AWS_REGION` |
| `OPENROUTER_API_KEY` | For OpenRouter | Server-side development API key |
| `OPENROUTER_MODEL` | For OpenRouter | Model identifier to request |

---

## Testing & Verification

Causelark features a rigorous unit, integration, and E2E verification suite. All test suites run completely offline and credential-free by stubbing model outputs at the provider boundary.

The test coverage spans database persistence, simulation validation, scenarios, benchmark execution, counterfactual causality, agent comparison matrix isolation, and adversarial sandboxing of the Operator agent.

### Verification Status

| Gate | Command | Result |
| --- | --- | --- |
| **Local Test Suite** | `npm run test` | **1,453 tests passing** (fully offline) |
| **Linter / Formatter** | `npm run lint` | Passing |
| **Type Check** | `npm run typecheck` | Passing |
| **Production Build** | `npm run build` | Passing |

### Running the E2E Integration Suite

To execute the full database-backed integration harnesses (for benchmarks, comparisons, counterfactuals, and operator pipelines), target a clean throwaway database:

```bash
createdb causelark_verify
DATABASE_URL='postgresql://localhost:5432/causelark_verify' npm run db:migrate:deploy
DATABASE_URL='postgresql://localhost:5432/causelark_verify' npx vitest run --config vitest.verification.config.ts
dropdb causelark_verify
```

---

## License

MIT. See [LICENSE](./LICENSE).
