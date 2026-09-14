// @vitest-environment node
//
// REPLAY — a recorded trading trajectory, reproduced from the rows alone.
//
// The platform's replay is one function, unchanged: `buildSimulationReplay`
// walks the persisted action records and emits one frame per record. Nothing in
// this file adds a trading branch to it, and the load-bearing assertion is that
// it does not re-decide anything — a frame carries the state the record says it
// produced, verbatim. If replay ever recomputed a transition, every run in the
// benchmark would be showing a trajectory nobody executed.
//
// The test that proves this is deliberately not "the replay matches the run",
// which a recomputing implementation would also pass. It perturbs one record's
// resulting state and asserts the perturbation survives into the frame: the only
// way to reproduce an edit you would never have made yourself is to read it.

import { describe, expect, it } from 'vitest';
import {
  buildSimulationReplay,
  jumpToImportantFrame,
  selectReplayFrame,
} from '@/lib/business/simulation-replay';
import {
  type SimulationActionInput,
  SimulationActionRecord,
  SimulationState,
} from '@/lib/contracts/simulation';
import {
  createInitialSimulationState,
  evaluateSimulationAction,
} from '@/lib/environments/registry';
import { TARGET_GAIN_DOLLARS } from '@/lib/trading/definitions';
import {
  disciplinedPolicy,
  NO_EVENTS,
  recklessPolicy,
  type ScriptedRun,
  scriptedRun,
} from './harness';

/** The platform's replay of one scripted run, over the rows it recorded. */
function replayOf(run: ScriptedRun) {
  return buildSimulationReplay({
    initialState: run.initialState,
    actions: run.actions,
    events: NO_EVENTS,
  });
}

describe('a trading run replays from its recorded rows', () => {
  const run = scriptedRun({ policy: disciplinedPolicy() });

  it('emits one frame per recorded action, plus the opening frame', () => {
    const replay = replayOf(run);
    expect(replay.frames).toHaveLength(run.actions.length + 1);
    expect(replay.frames.map((frame) => frame.index)).toEqual(
      Array.from({ length: run.actions.length + 1 }, (_, index) => index),
    );
  });

  it('carries each frame the state its own record says it produced, exactly', () => {
    const replay = replayOf(run);
    expect(replay.frames[0]?.state).toEqual(run.initialState);
    for (const [index, action] of run.actions.entries()) {
      const frame = replay.frames[index + 1];
      expect(frame?.state, `frame ${index + 1}`).toEqual(action.resultingState);
      // And the book travels with it: a frame is a whole world, not a summary.
      expect(frame?.state.trading, `frame ${index + 1}`).not.toBeNull();
      expect(frame?.step).toBe(action.resultingState.step);
    }
    expect(replay.frames.at(-1)?.state).toEqual(run.state);
  });

  it('reproduces a recorded state it could not have derived, rather than recomputing', () => {
    // The proof that replay reads the row instead of re-running the world. One
    // record's resulting state is edited to a portfolio no policy in this file
    // would ever produce; a replay that recomputed would quietly overwrite it,
    // and a reader would be auditing a trajectory that never happened.
    const last = run.actions.at(-1);
    if (!last?.resultingState.trading) throw new Error('expected a trading book');
    const edited = SimulationActionRecord.parse({
      ...last,
      resultingState: {
        ...last.resultingState,
        budgetRemaining: 1,
        trading: { ...last.resultingState.trading, cash: 123 },
      },
    });
    expect(edited.resultingState).not.toEqual(last.resultingState);

    const replay = buildSimulationReplay({
      initialState: run.initialState,
      actions: [...run.actions.slice(0, -1), edited],
      events: NO_EVENTS,
    });
    const frame = replay.frames.at(-1);
    expect(frame?.state.budgetRemaining).toBe(1);
    expect(frame?.state.trading?.cash).toBe(123);
  });

  it('labels a refused order as refused, and marks it worth stopping on', () => {
    // The reckless policy asks for orders the environment refuses, so this run
    // has both kinds of frame in it.
    const refused = scriptedRun({ policy: recklessPolicy('GAMMA') });
    expect(refused.actions.some((action) => !action.accepted)).toBe(true);
    const replay = replayOf(refused);
    for (const [index, action] of refused.actions.entries()) {
      const frame = replay.frames[index + 1];
      expect(frame?.label, `frame ${index + 1}`).toBe(
        action.accepted ? `Validated ${action.type}` : `Rejected ${action.type}`,
      );
      // A refusal is not progress, and the frame says so.
      if (!action.accepted) expect(frame?.important).toBe(true);
    }
    expect(replay.importantFrameIndexes).toContain(0);
  });

  it('marks the frame where the objective was reached worth stopping on', () => {
    const completed = scriptedRun({ policy: disciplinedPolicy() });
    expect(completed.state.progress).toBeGreaterThanOrEqual(TARGET_GAIN_DOLLARS);
    const replay = replayOf(completed);
    const reached = replay.frames
      .map((frame) => frame.state.progress >= TARGET_GAIN_DOLLARS)
      .lastIndexOf(true);
    expect(reached).toBeGreaterThan(0);
    expect(replay.frames[reached]?.important).toBe(true);
  });

  it('projects the diff list onto the fields shared by every world', () => {
    // The recorded diff names the scalar fields the platform projects for all
    // runs. The trading book itself is NOT among them: it is a nested structure,
    // and it travels on the frame's own state rather than as a before/after pair
    // in this list. Pinned here so that if the projection ever widens, it is a
    // decision someone made about the replay pane rather than a silent change to
    // what a frame reports as having moved.
    const replay = replayOf(run);
    const projected = [
      'step',
      'resources',
      'progress',
      'risk',
      'budgetRemaining',
      'budgetSpent',
      'lastAction',
    ];
    const named = new Set(replay.frames.flatMap((frame) => frame.diffs.map((diff) => diff.field)));
    for (const field of named) expect(projected, field).toContain(field);
    expect(named.has('step')).toBe(true);
    expect(named.has('budgetRemaining')).toBe(true);
    expect(named.has('trading')).toBe(false);
    // Every diff it does report is a change that really happened.
    for (const frame of replay.frames) {
      for (const diff of frame.diffs) expect(diff.before).not.toEqual(diff.after);
    }
  });

  it('changes nothing it was handed, and builds the same replay twice', () => {
    // Replay is a function of the rows. It is handed no way to reach a provider,
    // and the same rows must produce the same frames on a second build — which is
    // what makes a replay an audit rather than a re-enactment.
    const before = JSON.stringify(run.actions);
    const initial = JSON.stringify(run.initialState);
    expect(replayOf(run)).toEqual(replayOf(run));
    expect(JSON.stringify(run.actions)).toBe(before);
    expect(JSON.stringify(run.initialState)).toBe(initial);
  });

  it('replays a run that never terminated, because it replays what ran', () => {
    // A snapshot evaluation can be asked about a run still in flight. Its replay
    // is the trajectory so far, not a refusal and not an invented ending.
    const inFlight = scriptedRun({ policy: recklessPolicy('GAMMA') });
    expect(inFlight.evidence.status).toBe('RUNNING');
    const replay = replayOf(inFlight);
    expect(replay.frames).toHaveLength(inFlight.actions.length + 1);
    expect(replay.frames.at(-1)?.state.step).toBe(inFlight.state.step);
  });
});

describe('the replay controls behave on a trading run', () => {
  const run = scriptedRun({ policy: disciplinedPolicy() });
  const replay = replayOf(run);

  it('defaults to the last frame and clamps a selection into range', () => {
    expect(replay.selectedFrame).toBe(replay.frames.length - 1);
    const past = buildSimulationReplay({
      initialState: run.initialState,
      actions: run.actions,
      events: NO_EVENTS,
      selectedFrame: 9_999,
    });
    expect(past.selectedFrame).toBe(replay.frames.length - 1);
    expect(selectReplayFrame(replay, -5)).toEqual(replay.frames[0]);
    expect(selectReplayFrame(replay, 9_999)).toEqual(replay.frames.at(-1));
  });

  it('steps to the next and previous noteworthy frame, and stops at the ends', () => {
    const important = replay.importantFrameIndexes;
    expect(important.length).toBeGreaterThan(1);
    const first = important[0] as number;
    expect(jumpToImportantFrame(replay, 1, first)).toBe(important[1]);
    expect(jumpToImportantFrame(replay, -1, first)).toBe(first);
    expect(jumpToImportantFrame(replay, 1, replay.frames.length - 1)).toBe(
      replay.frames.length - 1,
    );
  });
});

describe('the replay is the platform’s, shared with the resource world', () => {
  it('reproduces a resource-routing trajectory through the same function', () => {
    // One replay path, two worlds. A trading-specific replay would be a second
    // implementation of something the console already renders, and the two would
    // drift. The resource run here is driven by the registry's own transitions.
    const initialState = createInitialSimulationState(
      'resource-routing',
      'complete-delivery',
      1042,
    );
    const requests: SimulationActionInput[] = [
      { type: 'harvest', resource: 'materials', amount: 1 },
      { type: 'hold', amount: 1 },
    ];
    let state = initialState;
    const actions = requests.map((requested, index) => {
      const evaluation = evaluateSimulationAction(state, requested);
      const record = SimulationActionRecord.parse({
        id: `resource-action-${index}`,
        step: state.step,
        type: requested.type,
        input: requested,
        source: 'agent',
        accepted: evaluation.accepted,
        rejectionReason: evaluation.rejectionReason,
        observation: evaluation.observation,
        stateDiff: evaluation.stateDiff ?? {},
        resultingState: evaluation.state,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      state = evaluation.state;
      return record;
    });

    const replay = buildSimulationReplay({
      initialState,
      actions,
      events: NO_EVENTS,
    });
    expect(replay.frames).toHaveLength(3);
    expect(replay.frames[1]?.state.resources.materials).toBeGreaterThan(0);
    // The resource world's frames carry no trading book, and the shared function
    // has to be indifferent to that rather than branching on it.
    expect(replay.frames[1]?.state.trading).toBeNull();
    expect(replay.frames[1]?.state.environmentKey).toBe('resource-routing');
    expect(SimulationState.safeParse(replay.frames[1]?.state).success).toBe(true);
  });
});
