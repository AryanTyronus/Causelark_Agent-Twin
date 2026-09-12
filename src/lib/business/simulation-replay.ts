// @polsia:user-owned — deterministic replay reconstruction from persisted records.

import {
  type SimulationActionRecord,
  type SimulationEvent,
  SimulationReplay,
  type SimulationReplayFrame,
  type SimulationState,
} from '@/lib/contracts/simulation';

function stateDiff(before: SimulationState, after: SimulationState) {
  const fields: Array<keyof SimulationState> = [
    'step',
    'resources',
    'progress',
    'risk',
    'budgetRemaining',
    'budgetSpent',
    'lastAction',
  ];
  return fields.flatMap((field) =>
    JSON.stringify(before[field]) === JSON.stringify(after[field])
      ? []
      : [{ field, before: before[field], after: after[field] }],
  );
}

export function buildSimulationReplay(input: {
  initialState: SimulationState;
  actions: SimulationActionRecord[];
  events: SimulationEvent[];
  selectedFrame?: number;
}) {
  const frames: SimulationReplayFrame[] = [];
  let previous = input.initialState;
  frames.push({
    index: 0,
    step: 0,
    eventId: input.events.find((event) => event.kind === 'simulation.started')?.id ?? null,
    label: 'Initial observable state',
    state: previous,
    diffs: [],
    important: true,
  });
  input.actions.forEach((action, actionIndex) => {
    const next = action.resultingState;
    const event = input.events.find(
      (item) =>
        item.step === action.step &&
        (item.kind === 'action.validated' || item.kind === 'action.rejected'),
    );
    frames.push({
      index: actionIndex + 1,
      step: next.step,
      eventId: event?.id ?? null,
      label: action.accepted ? `Validated ${action.type}` : `Rejected ${action.type}`,
      state: next,
      diffs: stateDiff(previous, next),
      important: !action.accepted || next.progress >= next.target || next.risk >= next.maxRisk,
    });
    previous = next;
  });
  const importantFrameIndexes = frames
    .filter((frame) => frame.important)
    .map((frame) => frame.index);
  return SimulationReplay.parse({
    frames,
    importantFrameIndexes,
    selectedFrame: Math.min(
      Math.max(input.selectedFrame ?? frames.length - 1, 0),
      Math.max(frames.length - 1, 0),
    ),
  });
}

export function selectReplayFrame(replay: SimulationReplay, index: number) {
  return (
    replay.frames[Math.min(Math.max(index, 0), Math.max(replay.frames.length - 1, 0))] ??
    replay.frames[0]
  );
}

export function jumpToImportantFrame(replay: SimulationReplay, direction: 1 | -1, from: number) {
  const indexes = replay.importantFrameIndexes.filter((index) =>
    direction === 1 ? index > from : index < from,
  );
  return direction === 1 ? (indexes[0] ?? from) : (indexes.at(-1) ?? from);
}
