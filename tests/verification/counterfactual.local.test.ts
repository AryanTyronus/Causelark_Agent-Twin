// @polsia:user-owned — local integration verification for the counterfactual engine.
//
// This harness is NOT part of the unit suite (`npm test` includes only
// `tests/unit/**`). It runs the counterfactual analysis against a real PostgreSQL
// database, through the real routes, the real persistence layer, the real
// environment and the real evaluation engine — and it checks the analysis against
// the trace the database actually holds, rather than against a fixture.
//
// Nothing here is stubbed except authentication, because the point is to prove
// that the same run an operator can replay and evaluate is the run a
// counterfactual is computed from. No model call is made: every action is
// recorded through the operator endpoint, which the environment validates
// exactly as it validates an agent's.
//
// Run with:
//   npx vitest run --config vitest.verification.config.ts
//
// It expects a DISPOSABLE database — it creates real runs and does not remove
// them. See the report accompanying this phase for the exact procedure (create a
// sibling database, `prisma migrate deploy`, run this, drop it).

import { describe, expect, it, vi } from 'vitest';

const OWNER = 'counterfactual-local-verification';
const FOREIGN_OWNER = 'counterfactual-local-foreign';

/**
 * The identity the auth gate resolves. Swapping an identity is not a live
 * request: there is no second session here, only a mock answering as a
 * different user, which is what the endpoint's owner scoping has to be checked
 * against.
 */
let currentOwner = OWNER;

vi.mock('server-only', () => ({}));

vi.mock('@/lib/require-auth', () => ({
  requireAuth: async () => ({ id: currentOwner, email: `${currentOwner}@example.test` }),
}));

import { POST as recordAction } from '@/app/api/simulations/runs/[runId]/actions/route';
import { GET as getCounterfactual } from '@/app/api/simulations/runs/[runId]/counterfactual/route';
import { GET as getEvaluation } from '@/app/api/simulations/runs/[runId]/evaluation/route';
import { POST as startRun } from '@/app/api/simulations/runs/route';
import { toEvaluationInput } from '@/lib/business/simulation-evaluation';
import { loadRun } from '@/lib/business/simulation-persistence';
import { enumerateCandidates, validCandidates } from '@/lib/counterfactual/actions';
import { analyzeCounterfactuals, analyzeDecisionAt } from '@/lib/counterfactual/counterfactual';
import { decisionAt } from '@/lib/counterfactual/decisions';
import { counterfactualEvidence } from '@/lib/counterfactual/evidence';
import type {
  CounterfactualDecisionAnalysis,
  CounterfactualReport,
} from '@/lib/counterfactual/types';
// biome-ignore lint/style/noRestrictedImports: this harness counts rows either side of an analysis to prove it writes nothing; it is a verification script, not app code.
import { prisma } from '@/lib/db';
import { evaluateRun } from '@/lib/evaluation/evaluation';

const SEED = 1042;

/** A plan the environment accepts, which nevertheless misses the objective. */
const PLAN = [
  { type: 'allocate', resource: 'materials', amount: 1 },
  { type: 'allocate', resource: 'materials', amount: 1 },
  { type: 'allocate', resource: 'materials', amount: 1 },
  { type: 'allocate', resource: 'materials', amount: 1 },
  // Refused: four units of materials are gone, so five cannot be allocated. It
  // sits mid-run on purpose, so a branch replaying the run reaches it.
  { type: 'allocate', resource: 'materials', amount: 5 },
  { type: 'harvest', resource: 'energy', amount: 1 },
  { type: 'harvest', resource: 'energy', amount: 1 },
  { type: 'harvest', resource: 'energy', amount: 1 },
  { type: 'harvest', resource: 'energy', amount: 1 },
  { type: 'harvest', resource: 'energy', amount: 1 },
  { type: 'rest', amount: 1 },
  { type: 'rest', amount: 1 },
  { type: 'rest', amount: 1 },
  // Refused: twelve steps have been taken, so the run is already over.
  { type: 'allocate', resource: 'water', amount: 2 },
];

/** The attempts the environment accepted, which is what the identity replay covers. */
const ACCEPTED_ATTEMPTS = 12;

function url(runId: string, query = ''): Request {
  return new Request(`http://localhost/api/simulations/runs/${runId}/counterfactual${query}`);
}

function params(runId: string): { params: Promise<{ runId: string }> } {
  return { params: Promise.resolve({ runId }) };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Start a run and record `PLAN` against it, through the real endpoints. */
async function runThePlan(): Promise<string> {
  currentOwner = OWNER;
  const started = await startRun(
    new Request('http://localhost/api/simulations/runs', {
      method: 'POST',
      body: JSON.stringify({
        environmentKey: 'resource-routing',
        objectiveKey: 'complete-delivery',
        seed: SEED,
      }),
    }),
  );
  expect(started.status).toBe(201);
  // The collection endpoint answers with the run detail itself.
  const { id } = await readJson<{ id: string }>(started);
  for (const action of PLAN) {
    const response = await recordAction(
      new Request(`http://localhost/api/simulations/runs/${id}/actions`, {
        method: 'POST',
        body: JSON.stringify(action),
      }),
      params(id),
    );
    // A refused action answers 409: the attempt was recorded, the world did not
    // move. Both are expected here.
    expect([200, 409]).toContain(response.status);
  }
  return id;
}

let runId = '';
let report: CounterfactualReport;

describe('1–3. the run the analysis is computed from', () => {
  it('starts a run and records a full trace through the real endpoints', async () => {
    runId = await runThePlan();
    const run = await loadRun(runId, OWNER);
    if (!run) throw new Error('The run could not be read back.');
    expect(run.ownerId).toBe(OWNER);
    expect(run.seed).toBe(SEED);
    expect(run.actions).toHaveLength(PLAN.length);
    // The run ended, and the accepted attempts plus the two the environment
    // refused — one mid-run, one after the run was already over — are exactly
    // what the endpoints recorded.
    expect(run.status).toBe('LIMIT_REACHED');
    expect(run.actions.filter((action) => action.accepted)).toHaveLength(ACCEPTED_ATTEMPTS);
    expect(run.actions.filter((action) => !action.accepted)).toHaveLength(2);
  });

  it('holds a state the evaluation engine can score', async () => {
    const response = await getEvaluation(url(runId), params(runId));
    expect(response.status).toBe(200);
    const body = await readJson<{ evaluation: { overallScore: number }; inProgress: boolean }>(
      response,
    );
    expect(body.inProgress).toBe(false);
    expect(body.evaluation.overallScore).toBeGreaterThan(0);
  });

  it('analyzes the persisted trace without a second simulation', async () => {
    const response = await getCounterfactual(url(runId), params(runId));
    expect(response.status).toBe(200);
    report = await readJson<CounterfactualReport>(response);
    expect(report.run.runId).toBe(runId);
    expect(report.run.decisionPointCount).toBe(PLAN.length);
    expect(report.run.status).toBe('LIMIT_REACHED');
    expect(report.run.inProgress).toBe(false);
  });
});

describe('4–6. the report against the database', () => {
  it('reports the world the run is actually in', async () => {
    const run = await loadRun(runId, OWNER);
    if (!run) throw new Error('The run could not be read back.');
    const persisted = run.state as unknown as {
      step: number;
      progress: number;
      target: number;
      risk: number;
      budgetSpent: number;
      resources: Record<string, number>;
    };
    expect(report.run.world.step).toBe(persisted.step);
    expect(report.run.world.progress).toBe(persisted.progress);
    expect(report.run.world.target).toBe(persisted.target);
    expect(report.run.world.objectiveReached).toBe(persisted.progress >= persisted.target);
    expect(report.run.world.risk).toBe(persisted.risk);
    expect(report.run.world.budgetSpent).toBe(persisted.budgetSpent);
    expect(report.run.world.resources).toEqual(persisted.resources);
  });

  it('compares against the same verdict the evaluation endpoint serves', async () => {
    const response = await getEvaluation(url(runId), params(runId));
    const body = await readJson<{ evaluation: { overallScore: number; categories: unknown[] } }>(
      response,
    );
    expect(report.baseline.overallScore).toBe(body.evaluation.overallScore);
    // The report's dimension scores are that verdict's, re-projected.
    expect(Object.keys(report.baseline.scores)).toHaveLength(body.evaluation.categories.length);
  });

  it('is a function of the persisted evidence, not of the request', async () => {
    const run = await loadRun(runId, OWNER);
    if (!run) throw new Error('The run could not be read back.');
    // The route's answer is the engine's answer for the mapping the route used.
    const inProcess = analyzeCounterfactuals(toEvaluationInput(run)).report;
    expect(report).toEqual(inProcess);
    // And a second request returns the same bytes.
    const again = await getCounterfactual(url(runId), params(runId));
    expect(await again.text()).toBe(JSON.stringify(report));
  });

  it('treats the refused attempt as a decision point of its own', () => {
    const last = report.decisions.at(-1);
    if (!last) throw new Error('The report carries no decisions.');
    expect(last.index).toBe(PLAN.length - 1);
    expect(last.actual.accepted).toBe(false);
    expect(last.actual.rejectionReason).not.toBeNull();
    // The run finished, so the environment refused the attempt's alternatives —
    // the decision had no valid action left to take.
    expect(last.space.valid).toBe(0);
    expect(last.space.invalid).toBeGreaterThan(0);
    expect(last.regret).toBeNull();
    expect(report.summary.uncontestedDecisions).toBe(1);
  });
});

describe('7–9. the report’s internal accounting', () => {
  it('partitions the decision points and the action space exactly', () => {
    const summary = report.summary;
    expect(
      summary.improvingDecisions +
        summary.equivalentDecisions +
        summary.worseningDecisions +
        summary.uncontestedDecisions,
    ).toBe(summary.decisionPoints);
    expect(summary.decisionPoints).toBe(PLAN.length);
    expect(summary.validActions + summary.invalidActions).toBe(summary.enumeratedActions);
    expect(summary.enumeratedActions).toBe(PLAN.length * 35);
    // Every accepted decision gave up one alternative — the choice that was made
    // is not an alternative to itself. A refused decision's recorded choice was
    // never in the valid space, so it gave up none.
    expect(summary.alternativesAnalysed).toBe(summary.validActions - ACCEPTED_ATTEMPTS);
  });

  it('ranks by regret with a defined tie-break and no gaps', () => {
    const ranked = report.causal.ranking;
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.map((entry) => entry.rank)).toEqual(ranked.map((_entry, offset) => offset + 1));
    for (let index = 1; index < ranked.length; index += 1) {
      const previous = ranked[index - 1];
      const current = ranked[index];
      if (!previous || !current) throw new Error('The ranking is shorter than expected.');
      expect(
        previous.regret > current.regret ||
          (previous.regret === current.regret && previous.index < current.index),
      ).toBe(true);
    }
    // Every decision with alternatives is ranked, and only those. The ranking is
    // ordered by regret, so the two are compared as sets of indices.
    expect([...ranked.map((entry) => entry.index)].sort((left, right) => left - right)).toEqual(
      report.decisions
        .filter((decision) => decision.regret !== null)
        .map((decision) => decision.index),
    );
  });

  it('names a critical decision only when one gave something up', () => {
    const critical = report.causal.criticalDecision;
    if ((report.summary.maxRegret ?? 0) > 0) {
      expect(critical).not.toBeNull();
      expect(critical?.regret).toBe(report.summary.maxRegret);
      expect(critical?.rank).toBe(1);
      expect(critical?.statement).toContain('replay-recorded-attempts-v1');
    } else expect(critical).toBeNull();
  });

  it('keeps every aggregate inside the range of what it aggregates', () => {
    const best = report.summary.bestAlternativeOverall;
    const worst = report.summary.worstAlternativeOverall;
    for (const decision of report.decisions) {
      if (decision.best === null || best === null || worst === null) continue;
      expect(decision.best.outcome.overallScore).toBeLessThanOrEqual(best);
      expect(decision.best.outcome.overallScore).toBeGreaterThanOrEqual(worst);
    }
  });
});

describe('10–11. the drill-down', () => {
  it('serves one decision with every alternative behind it', async () => {
    const response = await getCounterfactual(url(runId, '?decision=0'), params(runId));
    expect(response.status).toBe(200);
    const analysis = await readJson<CounterfactualDecisionAnalysis>(response);
    expect(analysis.run.runId).toBe(runId);
    expect(analysis.run.decisionPointCount).toBe(PLAN.length);
    expect(analysis.decision.index).toBe(0);
    expect(analysis.alternatives.length).toBeGreaterThan(0);
    for (const alternative of analysis.alternatives) {
      // Each alternative travels with the world it reaches and the verdict the
      // evaluation engine returned for it.
      expect(alternative.state.progress).toBe(alternative.world.progress);
      expect(alternative.evaluation.overallScore).toBe(alternative.outcome.overallScore);
      expect(alternative.evaluation.status).toBe(alternative.continuation.terminalStatus);
      expect(alternative.delta.overall).toBe(
        alternative.outcome.overallScore - report.baseline.overallScore,
      );
    }
    // The recorded choice is not an alternative to itself, but the space counts it.
    expect(analysis.alternatives.map((entry) => entry.key)).not.toContain('allocate:materials:1');
    expect(analysis.decision.space.valid).toBeGreaterThan(analysis.alternatives.length);
    expect(analysis.policies.continuation).toBe('replay-recorded-attempts-v1');
  });

  it('agrees with the report it was split out of', async () => {
    const response = await getCounterfactual(url(runId, '?decision=3'), params(runId));
    const analysis = await readJson<CounterfactualDecisionAnalysis>(response);
    const run = await loadRun(runId, OWNER);
    if (!run) throw new Error('The run could not be read back.');
    const inProcess = analyzeDecisionAt(toEvaluationInput(run), 3);
    expect(analysis).toEqual(inProcess);
    expect(analysis.decision).toEqual(report.decisions[3]);
  });

  it('answers a decision index the run does not have with a bad request', async () => {
    const response = await getCounterfactual(url(runId, '?decision=999'), params(runId));
    expect(response.status).toBe(400);
    const body = await readJson<{ code: string }>(response);
    expect(body.code).toBe('UNKNOWN_DECISION');
  });

  it('answers a decision parameter that is not an index with a bad request', async () => {
    for (const value of ['-1', 'abc', '1.5']) {
      const response = await getCounterfactual(url(runId, `?decision=${value}`), params(runId));
      expect(response.status, `decision=${value}`).toBe(400);
      expect(response.status).not.toBe(500);
    }
  });
});

describe('12. the analysis is read-only and owner-scoped', () => {
  it('writes nothing to the database', async () => {
    const before = await Promise.all([
      prisma.simulationRun.count(),
      prisma.simulationAction.count(),
      prisma.simulationEvent.count(),
      prisma.simulationToolCall.count(),
    ]);
    await getCounterfactual(url(runId), params(runId));
    await getCounterfactual(url(runId, '?decision=2'), params(runId));
    const after = await Promise.all([
      prisma.simulationRun.count(),
      prisma.simulationAction.count(),
      prisma.simulationEvent.count(),
      prisma.simulationToolCall.count(),
    ]);
    expect(after).toEqual(before);
  });

  it('answers a foreign owner exactly as it answers for a run that does not exist', async () => {
    currentOwner = FOREIGN_OWNER;
    try {
      const foreign = await getCounterfactual(url(runId), params(runId));
      const missing = await getCounterfactual(url('no-such-run'), params('no-such-run'));
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      // The two answers are indistinguishable, so the endpoint cannot be used to
      // learn whether someone else's run id exists.
      expect(await foreign.text()).toBe(await missing.text());
    } finally {
      currentOwner = OWNER;
    }
  });
});

describe('13. the recorded choice, replayed against the real trace', () => {
  it('reproduces the persisted run exactly, transition for transition', async () => {
    const run = await loadRun(runId, OWNER);
    if (!run) throw new Error('The run could not be read back.');
    const source = toEvaluationInput(run);
    const recordedVerdict = evaluateRun(source);
    const baseline = recordedVerdict.overallScore;

    // Every decision the environment accepted, replayed as its own alternative,
    // lands on the run the database holds: same world, same status, same attempt
    // pattern, same verdict. This is the engine's central correctness property —
    // a branch that gets the recorded choice wrong gets every other alternative
    // wrong too, and the two refusals in this trace are the cases where a branch
    // could quietly disagree with the run it is compared against.
    let checked = 0;
    for (const [index, action] of source.actions.entries()) {
      if (!action.accepted) continue;
      const context = decisionAt(source, index);
      const chosen = context.recorded.input;
      const identity = validCandidates(enumerateCandidates(context.state)).find(
        (candidate) =>
          candidate.action.type === chosen.type &&
          candidate.action.amount === chosen.amount &&
          candidate.action.resource === chosen.resource,
      );
      if (!identity) throw new Error(`Decision ${index} is not in its own action space.`);

      const evidence = counterfactualEvidence({ source, decision: context, candidate: identity });
      const label = `decision ${index}`;
      // The branch reaches the world the run reached...
      expect(evidence.trajectory.state, label).toEqual(source.state);
      expect(evidence.trajectory.continuation.terminalStatus, label).toBe(source.status);
      // ...by making the same number of attempts and being refused the same
      // number of times, because a refused attempt is a scored quantity.
      expect(evidence.input.actions, label).toHaveLength(source.actions.length);
      expect(
        evidence.input.actions.filter((attempt) => !attempt.accepted),
        label,
      ).toHaveLength(2);
      // ...and the evaluation engine's verdict on it is the verdict on the run.
      const { runId: branchId, ...branchVerdict } = evidence.evaluation;
      const { runId: recordedId, ...runVerdict } = recordedVerdict;
      expect(branchId, label).toBe(evidence.branchId);
      expect(recordedId, label).toBe(source.runId);
      expect(branchId, label).not.toBe(recordedId);
      expect(branchVerdict, label).toEqual(runVerdict);
      expect(evidence.evaluation.overallScore, label).toBe(baseline);
      checked += 1;
    }
    expect(checked).toBe(ACCEPTED_ATTEMPTS);
  });

  it('preserves the run’s refusals in the branch that replays them', async () => {
    const run = await loadRun(runId, OWNER);
    if (!run) throw new Error('The run could not be read back.');
    const source = toEvaluationInput(run);
    // Replaying the very first choice as its own alternative replays every
    // attempt that followed it — the refused one included, and the one the run
    // made after the environment had already ended it.
    const context = decisionAt(source, 0);
    const chosen = context.recorded.input;
    const identity = validCandidates(enumerateCandidates(context.state)).find(
      (candidate) =>
        candidate.action.type === chosen.type &&
        candidate.action.amount === chosen.amount &&
        candidate.action.resource === chosen.resource,
    );
    if (!identity) throw new Error('The recorded action is not in its own space.');
    const evidence = counterfactualEvidence({ source, decision: context, candidate: identity });
    const continuation = evidence.trajectory.continuation;
    expect(continuation.replayed).toBe(ACCEPTED_ATTEMPTS + 1);
    expect(continuation.rejected).toBe(2);
    expect(continuation.accepted).toBe(ACCEPTED_ATTEMPTS - 1);
    // The world ended before the attempt pattern ran out, and the engine says so
    // rather than trimming the pattern to match.
    expect(continuation.terminatedEarly).toBe(true);
    // The refused attempts carry the environment's own reasons, in order: the
    // mid-run one could not be satisfied, the post-terminal one could not be
    // requested at all.
    const refusals = evidence.input.actions.filter((attempt) => !attempt.accepted);
    expect(refusals.map((attempt) => attempt.rejectionReason)).toEqual([
      'Not enough materials to allocate 5.',
      'This run has already terminated.',
    ]);
  });
});
