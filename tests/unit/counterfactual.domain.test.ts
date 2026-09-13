// @vitest-environment node
//
// These tests pin the three derivations the analysis rests on: the action space
// the environment actually admits, the decision points read out of a persisted
// trace, and the continuation a branch takes. None of them asserts a formula
// this engine owns — the action space is the action contract's own vocabulary,
// validity is the environment's own verdict, and a transition is the
// environment's own transition function. What is asserted is that this engine
// asks the environment rather than answering for it.

import { describe, expect, it } from 'vitest';
import {
  createInitialSimulationState,
  evaluateSimulationAction,
  getSimulationStatus,
} from '@/lib/business/simulation';
import { SimulationActionInput } from '@/lib/contracts/simulation';
import {
  ACTION_AMOUNTS,
  actionKey,
  canonicalAction,
  enumerateActionSpace,
  enumerateCandidates,
  rejectedCandidates,
  rejectionCounts,
  validCandidates,
} from '@/lib/counterfactual/actions';
import {
  buildTrajectory,
  counterfactualActionId,
  counterfactualTerminal,
  projectWorld,
} from '@/lib/counterfactual/continuation';
import {
  assertAnalysable,
  decisionAt,
  extractDecisionPoints,
} from '@/lib/counterfactual/decisions';
import { CounterfactualError } from '@/lib/counterfactual/types';
import {
  POST_TERMINAL_PLAN,
  REFUSED_PLAN,
  STEP_LIMITED_PLAN,
  traceFixture,
} from './counterfactual.fixtures';

const SEED = 1042;
const initial = createInitialSimulationState('resource-routing', 'complete-delivery', SEED);

function codeOf(run: () => unknown): string {
  try {
    run();
    return 'NO_ERROR';
  } catch (error) {
    if (error instanceof CounterfactualError) return error.code;
    throw error;
  }
}

describe('the action space', () => {
  it('takes its amount range from the action contract rather than restating it', () => {
    // The probe's bound is a search limit; the contract's own maximum is what
    // decides the answer. If the contract widened `amount`, this would widen.
    expect(ACTION_AMOUNTS).toEqual([1, 2, 3, 4, 5]);
    expect(SimulationActionInput.safeParse({ type: 'rest', amount: 6 }).success).toBe(false);
    expect(SimulationActionInput.safeParse({ type: 'rest', amount: 5 }).success).toBe(true);
  });

  it('is enumerated in a fixed type → resource → amount order', () => {
    const space = enumerateActionSpace();
    expect(space).toHaveLength(15 * 2 + 5);
    // rest takes no resource, so it contributes one amount axis, not three.
    expect(space.slice(0, 5).map(actionKey)).toEqual([
      'harvest:energy:1',
      'harvest:energy:2',
      'harvest:energy:3',
      'harvest:energy:4',
      'harvest:energy:5',
    ]);
    expect(space.slice(15, 20).map(actionKey)).toEqual([
      'allocate:energy:1',
      'allocate:energy:2',
      'allocate:energy:3',
      'allocate:energy:4',
      'allocate:energy:5',
    ]);
    expect(space.slice(30).map(actionKey)).toEqual([
      'rest:-:1',
      'rest:-:2',
      'rest:-:3',
      'rest:-:4',
      'rest:-:5',
    ]);
    // A second enumeration is the same enumeration: the space is a function of
    // the contract, not of iteration.
    expect(enumerateActionSpace()).toEqual(space);
  });

  it('canonicalises a rest action so a meaningless resource is not a second choice', () => {
    expect(canonicalAction({ type: 'rest', resource: 'energy', amount: 3 })).toEqual({
      type: 'rest',
      amount: 3,
    });
    expect(actionKey({ type: 'rest', resource: 'water', amount: 3 })).toBe(
      actionKey({ type: 'rest', amount: 3 }),
    );
    // Every enumerated action is already canonical, so no two entries collide.
    const space = enumerateActionSpace();
    expect(new Set(space.map(actionKey)).size).toBe(space.length);
  });

  it('asks the environment which actions the state accepts, and reports its codes', () => {
    const candidates = enumerateCandidates(initial);
    expect(candidates).toHaveLength(35);
    // The initial world has room in every resource, so nothing is refused yet.
    expect(validCandidates(candidates)).toHaveLength(35);
    expect(rejectedCandidates(candidates)).toHaveLength(0);

    // A candidate's verdict is the environment's verdict, not a re-derivation.
    for (const candidate of candidates) {
      const verdict = evaluateSimulationAction(initial, candidate.action);
      expect(candidate.accepted).toBe(verdict.accepted);
      expect(candidate.state).toEqual(verdict.state);
      expect(candidate.observation).toBe(verdict.observation);
    }
  });

  it('measures every candidate against the same starting state', () => {
    // The environment's transition is pure, so building the space cannot move
    // the world the later candidates are judged in.
    const before = JSON.stringify(initial);
    enumerateCandidates(initial);
    expect(JSON.stringify(initial)).toBe(before);
  });

  it('groups refusals by the environment’s own code, in first-appearance order', () => {
    const state = traceFixture({ actions: REFUSED_PLAN }).state;
    const rejected = rejectedCandidates(enumerateCandidates(state));
    expect(rejected.length).toBeGreaterThan(0);
    const codes = rejectionCounts(rejected);
    // Every counted refusal is one this module was handed; the codes are the
    // environment's, and the counts partition the refused candidates exactly.
    expect(codes.reduce((total, entry) => total + entry.count, 0)).toBe(rejected.length);
    expect(codes.every((entry) => entry.code !== '' && entry.code !== 'ACCEPTED')).toBe(true);
    // No code appears twice: the grouping is a partition, not a running tally.
    expect(new Set(codes.map((entry) => entry.code)).size).toBe(codes.length);
  });
});

describe('decision points read out of a trace', () => {
  it('places each action in the world it was requested against', () => {
    const source = traceFixture({ actions: STEP_LIMITED_PLAN });
    const decisions = extractDecisionPoints(source);
    expect(decisions).toHaveLength(STEP_LIMITED_PLAN.length);
    // The first action met the run's recorded initial state...
    expect(decisions[0]?.state).toEqual(source.initialState);
    // ...and every later action met the state the action before it produced.
    // The runtime persists each action's resulting state, so this is exact.
    decisions.forEach((decision, index) => {
      if (index === 0) return;
      expect(decision.state).toEqual(source.actions[index - 1]?.resultingState);
    });
  });

  it('carries the recorded step, id, provenance and outcome of each decision', () => {
    const source = traceFixture({ actions: REFUSED_PLAN });
    const decisions = extractDecisionPoints(source);
    expect(decisions.map((decision) => decision.point.index)).toEqual([0, 1, 2]);
    expect(decisions.map((decision) => decision.point.actionId)).toEqual(
      source.actions.map((action) => action.id),
    );
    expect(decisions.map((decision) => decision.point.accepted)).toEqual([true, true, false]);
    // The refusal is reported as the runtime recorded it, not re-described.
    expect(decisions[2]?.point.rejectionReason).toBe('Not enough materials to allocate 5.');
    expect(decisions[2]?.point.observation).toBe('No state change recorded.');
    expect(decisions[2]?.state).toEqual(source.actions[1]?.resultingState);
  });

  it('treats a refused attempt as a decision point in its own right', () => {
    // The choice happened whether or not the environment accepted it, so a run
    // of three attempts has three decision points even though one was refused.
    const source = traceFixture({ actions: REFUSED_PLAN });
    expect(extractDecisionPoints(source)).toHaveLength(3);
  });

  it('keeps the operator’s provenance distinct from the agent’s', () => {
    const source = traceFixture({
      actions: REFUSED_PLAN,
      sources: ['agent', 'manual', 'manual'],
    });
    const decisions = extractDecisionPoints(source);
    expect(decisions.map((decision) => decision.point.source)).toEqual([
      'agent',
      'manual',
      'manual',
    ]);
  });

  it('orders by the evidence’s own order', () => {
    const source = traceFixture({ actions: STEP_LIMITED_PLAN });
    const indices = extractDecisionPoints(source).map((decision) => decision.point.index);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('refuses a trace it cannot transition from, rather than guessing a state', () => {
    const source = traceFixture({ actions: STEP_LIMITED_PLAN });
    expect(
      codeOf(() =>
        assertAnalysable({
          ...source,
          actions: [{ ...source.actions[0], resultingState: { step: 'x' } } as never],
        }),
      ),
    ).toBe('INVALID_SOURCE');
    expect(codeOf(() => assertAnalysable({ ...source, initialState: null as never }))).toBe(
      'INVALID_SOURCE',
    );
    expect(codeOf(() => assertAnalysable({ ...source, state: { broken: true } as never }))).toBe(
      'INVALID_SOURCE',
    );
  });

  it('refuses a trace longer than the engine’s bound instead of analysing part of it', () => {
    const source = traceFixture({ actions: STEP_LIMITED_PLAN });
    const bloated = {
      ...source,
      actions: Array.from({ length: 65 }, (_unused, index) => {
        const template = source.actions[index % source.actions.length];
        if (!template) throw new Error('The fixture has no actions to pad from.');
        return { ...template, id: `padded-${index}` };
      }),
    };
    expect(codeOf(() => assertAnalysable(bloated))).toBe('TOO_MANY_DECISIONS');
    // The bound admits a full run: the runtime cannot produce more than a
    // handful of attempts per turn, and the run's step budget caps the rest.
    expect(source.actions.length).toBeLessThanOrEqual(64);
  });

  it('names the index asked for when there is no such decision', () => {
    const source = traceFixture({ actions: REFUSED_PLAN });
    expect(decisionAt(source, 2).point.index).toBe(2);
    const error = (() => {
      try {
        decisionAt(source, 3);
        return null;
      } catch (caught) {
        return caught as CounterfactualError;
      }
    })();
    expect(error?.code).toBe('UNKNOWN_DECISION');
    expect(error?.message).toContain('3 decision points');
    expect(codeOf(() => decisionAt(source, -1))).toBe('UNKNOWN_DECISION');
  });
});

describe('the continuation policy', () => {
  const source = traceFixture({ actions: STEP_LIMITED_PLAN });
  const decision = extractDecisionPoints(source)[0];
  if (!decision) throw new Error('The fixture has no decision points.');

  it('carries the past over verbatim and replaces only the decision itself', () => {
    const decisions = extractDecisionPoints(source);
    const later = decisions[8];
    if (!later) throw new Error('The fixture is shorter than the test expects.');
    const candidate = validCandidates(enumerateCandidates(later.state))[0];
    if (!candidate) throw new Error('The fixture state admits no action.');
    const trajectory = buildTrajectory({
      source,
      decisionIndex: later.point.index,
      recorded: later.recorded,
      candidate,
      before: later.state,
    });
    // Everything before the decision point is the recorded past, unchanged.
    expect(trajectory.actions.slice(0, later.point.index)).toEqual(
      source.actions.slice(0, later.point.index),
    );
    // The intervention sits exactly at the decision point.
    expect(trajectory.actions[later.point.index]?.input).toEqual(candidate.action);
    expect(trajectory.actions[later.point.index]?.step).toBe(later.recorded.step);
  });

  it('gives a derived record an id that is plainly not a stored one', () => {
    const candidate = validCandidates(enumerateCandidates(decision.state))[0];
    if (!candidate) throw new Error('The fixture state admits no action.');
    const trajectory = buildTrajectory({
      source,
      decisionIndex: 0,
      recorded: decision.recorded,
      candidate,
      before: decision.state,
    });
    expect(trajectory.actions[0]?.id).toBe(counterfactualActionId(source.runId, 0, 0));
    // Every id in the branch is unique, so no two transitions are the same row.
    const ids = trajectory.actions.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith(source.runId)).toBe(true);
  });

  it('re-asks the environment for every recorded accepted transition', () => {
    const candidate = validCandidates(enumerateCandidates(decision.state))[0];
    if (!candidate) throw new Error('The fixture state admits no action.');
    const trajectory = buildTrajectory({
      source,
      decisionIndex: 0,
      recorded: decision.recorded,
      candidate,
      before: decision.state,
    });
    // Each replayed record's verdict is the environment's verdict on the world
    // the replay had reached — nothing is assumed to succeed.
    for (const action of trajectory.actions.slice(1)) {
      const previous = trajectory.actions[trajectory.actions.indexOf(action) - 1];
      expect(action.step).toBe(previous?.resultingState.step);
    }
    const replayed = trajectory.actions.slice(1);
    expect(trajectory.continuation.replayed).toBe(replayed.length);
    expect(trajectory.continuation.accepted + trajectory.continuation.rejected).toBe(
      replayed.length,
    );
  });

  it('keeps re-asking the environment after the branch’s world has terminated', () => {
    // Reaching the objective terminates the run. The attempts recorded after that
    // point are still re-asked: the recorded run made them, and holding its attempt
    // pattern constant is what lets a branch be compared with the run on the same
    // terms — the evaluation engine counts refused attempts, so dropping them
    // would compare the branch over a prefix of the record.
    const candidate = validCandidates(enumerateCandidates(decision.state)).find(
      (entry) => entry.key === 'allocate:energy:5',
    );
    if (!candidate) throw new Error('The expected alternative is not valid in this world.');
    const trajectory = buildTrajectory({
      source,
      decisionIndex: 0,
      recorded: decision.recorded,
      candidate,
      before: decision.state,
    });
    expect(trajectory.continuation.terminatedEarly).toBe(true);
    expect(getSimulationStatus(trajectory.state).status).toBe('COMPLETED');
    // Eleven transitions were recorded after this decision, and every one of them
    // is replayed — three still land, eight are refused by the finished world.
    expect(source.actions.length - 1).toBe(11);
    expect(trajectory.continuation.replayed).toBe(11);
    expect(trajectory.continuation.accepted).toBe(3);
    expect(trajectory.continuation.rejected).toBe(8);
    expect(trajectory.actions).toHaveLength(1 + trajectory.continuation.replayed);
    // The refusals are the environment's, in its own words, and they left the
    // world where it was.
    const refused = trajectory.actions.filter((action) => !action.accepted);
    expect(refused.every((action) => action.rejectionReason !== null)).toBe(true);
    expect(refused.every((action) => action.resultingState.step === 4)).toBe(true);
  });

  it('reproduces a post-terminal refusal rather than dropping it', () => {
    // The recorded run made one request after the environment had already ended it,
    // and the environment refused that request. Replaying the run's last accepted
    // choice as its own alternative has to reproduce the refusal: it is part of the
    // attempt pattern the recorded run is scored on, so a branch that dropped it
    // would be compared against the run on different terms.
    const post = traceFixture({ actions: POST_TERMINAL_PLAN });
    const before = decisionAt(post, 11);
    const recorded = before.recorded.input;
    const identity = validCandidates(enumerateCandidates(before.state)).find(
      (entry) =>
        entry.action.type === recorded.type &&
        entry.action.amount === recorded.amount &&
        entry.action.resource === recorded.resource,
    );
    if (!identity) throw new Error('The recorded action is not in its own action space.');
    const trajectory = buildTrajectory({
      source: post,
      decisionIndex: 11,
      recorded: before.recorded,
      candidate: identity,
      before: before.state,
    });
    expect(trajectory.continuation.replayed).toBe(1);
    expect(trajectory.continuation.rejected).toBe(1);
    expect(trajectory.actions).toHaveLength(post.actions.length);
    expect(trajectory.state).toEqual(post.state);
    // The branch's last record says what the run's last record says.
    expect(trajectory.actions.at(-1)?.accepted).toBe(false);
    expect(trajectory.actions.at(-1)?.rejectionReason).toBe(post.actions.at(-1)?.rejectionReason);
  });

  it('reports a branch that ends where the environment left it', () => {
    expect(counterfactualTerminal(source, source.state)).toEqual({
      status: 'LIMIT_REACHED',
      terminationReason: 'Step budget exhausted.',
    });
    // The environment answers first: a branch that completes says so even though
    // the recorded run was step-limited.
    const completed = { ...source.state, progress: source.state.target };
    expect(counterfactualTerminal(source, completed).status).toBe('COMPLETED');
  });

  it('holds a non-environment ending constant, and reports a snapshot as running', () => {
    // A branch the environment never terminated is a snapshot, and says so.
    const midway = { ...source.state, step: 2 };
    expect(counterfactualTerminal({ ...source, status: 'RUNNING' }, midway)).toEqual({
      status: 'RUNNING',
      terminationReason: null,
    });
    // A run the turn budget or a provider fault stopped stopped for a reason the
    // intervention could not have changed, so the branch inherits that ending —
    // it is held constant along with the rest of the non-environment evidence.
    expect(
      counterfactualTerminal(
        { ...source, status: 'TIMEOUT', terminationReason: 'Turn budget exhausted.' },
        midway,
      ),
    ).toEqual({ status: 'TIMEOUT', terminationReason: 'Turn budget exhausted.' });
    expect(
      counterfactualTerminal(
        { ...source, status: 'ERROR', terminationReason: 'The provider timed out.' },
        midway,
      ),
    ).toEqual({ status: 'ERROR', terminationReason: 'The provider timed out.' });
  });

  it('projects the world to the quantities a reader compares', () => {
    expect(projectWorld(source.state)).toEqual({
      step: 12,
      progress: 4,
      target: 8,
      objectiveReached: false,
      risk: 3,
      maxRisk: 8,
      budgetSpent: 12,
      budgetRemaining: 12,
      resources: { energy: 12, materials: 3, water: 5 },
      completedTasks: 1,
    });
  });

  it('is deterministic: the same branch twice is the same branch', () => {
    const candidate = validCandidates(enumerateCandidates(decision.state))[0];
    if (!candidate) throw new Error('The fixture state admits no action.');
    const build = () =>
      buildTrajectory({
        source,
        decisionIndex: 0,
        recorded: decision.recorded,
        candidate,
        before: decision.state,
      });
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it('analyses an attempt recorded after termination without inventing a world', () => {
    // The last request of this run was refused because the run had already
    // ended, so its decision point meets the terminal world and every candidate
    // is refused there. That is a result, not an error.
    const post = traceFixture({ actions: POST_TERMINAL_PLAN });
    const last = extractDecisionPoints(post).at(-1);
    if (!last) throw new Error('The fixture has no decision points.');
    expect(last.point.accepted).toBe(false);
    expect(last.point.rejectionReason).toBe('This run has already terminated.');
    expect(validCandidates(enumerateCandidates(last.state))).toHaveLength(0);
  });
});
