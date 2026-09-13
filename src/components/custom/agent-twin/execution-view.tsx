//
// A test drives real model turns, so it takes real time, and the one thing this
// view must not do is pretend otherwise.
//
// It shows what has actually been recorded. Before the run request is sent it
// takes a snapshot of the owner's existing runs; while the request is in flight
// it re-reads that list and, for each run it has not seen before, reads that
// run's own record once to find out which agent and which case it belongs to.
// The attribution comes from the `simulation.started` event the run persisted
// for itself — the same event the run is reconstructed from — so every mark on
// this screen is a row that exists, not an estimate of how far along something
// probably is.
//
// There is no timer-driven progress bar, no interpolated percentage and no
// synthetic "step 3 of 7" narration. If a case has not recorded a run yet, it is
// shown as not started, because that is what is true. Runs that belong to another
// test — a different benchmark, or an agent this test did not select — are
// excluded by the facts the run recorded about itself, not by assumption.

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import {
  type SimulationRunDetail,
  SimulationRunDetail as SimulationRunDetailSchema,
  SimulationRunList as SimulationRunListSchema,
} from '@/lib/contracts/simulation';
import { scenarioLabel } from './format';
import { Notice, Panel, ProgressReading, StatusChip } from './ui';

/** How often the recorded run list is re-read while a test is in flight. */
const POLL_INTERVAL_MS = 2500;

/** One run this test recorded, with the attribution the run persisted. */
export interface RecordedRun {
  runId: string;
  status: string;
  /** From the run's own `simulation.started` event. `null` when unattributed. */
  agentId: string | null;
  agentVersion: string | null;
  /** `scenarioId@scenarioVersion#seed`, as the benchmark matrix recorded it. */
  caseKey: string | null;
  benchmarkId: string | null;
}

/** Read the attribution a run recorded for itself, or nothing. */
function attributionOf(detail: SimulationRunDetail): Omit<RecordedRun, 'runId' | 'status'> {
  const started = detail.events.find((event) => event.kind === 'simulation.started');
  const payload = started?.payload ?? {};
  const text = (key: string) => {
    const value = payload[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  return {
    agentId: text('agentId'),
    agentVersion: text('agentVersion'),
    caseKey: text('caseKey'),
    benchmarkId: text('benchmarkId'),
  };
}

export interface RunRecorder {
  /** Runs recorded since the snapshot, in the order they were first seen. */
  recorded: RecordedRun[];
  /** True while the recorder is polling. */
  recording: boolean;
  /**
   * Take the snapshot and begin polling. Must be awaited before the run request
   * is sent: a run created between the request and the snapshot would be
   * mistaken for a pre-existing one.
   */
  begin: () => Promise<void>;
  /** Stop polling. */
  stop: () => void;
}

/**
 * Record what a test actually produces, by reading the runs it creates.
 *
 * The seen-set lives in a ref rather than in state on purpose: it is bookkeeping
 * the view never renders, and putting it in state would make every poll a
 * re-render even when nothing new was recorded.
 */
export function useRunRecorder(): RunRecorder {
  const [recorded, setRecorded] = useState<RecordedRun[]>([]);
  const [recording, setRecording] = useState(false);
  const seen = useRef<Set<string>>(new Set());
  const timer = useRef<number | null>(null);
  const cancelled = useRef(false);

  const stop = useCallback(() => {
    cancelled.current = true;
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setRecording(false);
  }, []);

  const inspect = useCallback(async (runId: string): Promise<RecordedRun | null> => {
    try {
      const detail = await apiFetch(`/api/simulations/runs/${runId}`, {
        schema: SimulationRunDetailSchema,
      });
      return { runId, status: detail.status, ...attributionOf(detail) };
    } catch {
      // A run that cannot be read is not evidence this view can show. It is
      // skipped rather than counted, so progress only ever counts records that
      // were actually read.
      return null;
    }
  }, []);

  const poll = useCallback(async () => {
    if (cancelled.current) return;
    try {
      const list = await apiFetch('/api/simulations/runs', { schema: SimulationRunListSchema });
      const fresh = list.runs.filter((run) => !seen.current.has(run.id));
      for (const run of fresh) seen.current.add(run.id);
      const inspected = await Promise.all(fresh.map((run) => inspect(run.id)));
      const usable = inspected.filter((entry): entry is RecordedRun => entry !== null);
      if (usable.length > 0) setRecorded((current) => [...current, ...usable]);
    } catch {
      // A poll that fails is a moment this view could not see. It does not fail
      // the test, and it does not invent a reading to fill the gap.
    }
    if (!cancelled.current) timer.current = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
  }, [inspect]);

  const begin = useCallback(async () => {
    cancelled.current = false;
    seen.current = new Set();
    setRecorded([]);
    try {
      const list = await apiFetch('/api/simulations/runs', { schema: SimulationRunListSchema });
      for (const run of list.runs) seen.current.add(run.id);
    } catch {
      // Without a snapshot the recorder cannot tell this test's runs from any
      // other's. It says so rather than guessing: `recording` stays false and
      // the view states that progress could not be observed.
      setRecording(false);
      return;
    }
    setRecording(true);
    void poll();
  }, [poll]);

  useEffect(() => stop, [stop]);

  return { recorded, recording, begin, stop };
}

/** One planned case, matched against what has been recorded for it. */
export interface PlannedCaseProgress {
  key: string;
  scenarioId: string;
  seed: number;
  isBaseline: boolean;
  /** `null` until a run for this case has been read. */
  runId: string | null;
  status: string | null;
}

/**
 * Match recorded runs against the plan's own matrix.
 *
 * The plan comes from the experiment endpoint, which builds its cases from the
 * benchmark engine's matrix builder — so the cases listed here are the cases the
 * engine intends to run, not a second description of them written in the
 * interface. The plan names no agent, because the matrix is the same for every
 * agent by construction; the agents are the ones the operator declared, and each
 * is shown against that same case list.
 */
export function matchPlan(
  cases: readonly {
    key: string;
    scenarioId: string;
    scenarioVersion: number;
    seed: number;
    isBaseline: boolean;
  }[],
  agents: readonly { agentId: string; agentVersion: string }[],
  recorded: readonly RecordedRun[],
): Map<string, PlannedCaseProgress[]> {
  const byAgent = new Map<string, PlannedCaseProgress[]>();
  for (const agent of agents) {
    const identity = `${agent.agentId}@${agent.agentVersion}`;
    const list: PlannedCaseProgress[] = [];
    for (const entry of cases) {
      const match = recorded.find(
        (run) =>
          run.agentId === agent.agentId &&
          run.agentVersion === agent.agentVersion &&
          run.caseKey === `${entry.scenarioId}@${entry.scenarioVersion}#${entry.seed}`,
      );
      list.push({
        key: `${identity}|${entry.key}`,
        scenarioId: entry.scenarioId,
        seed: entry.seed,
        isBaseline: entry.isBaseline,
        runId: match?.runId ?? null,
        status: match?.status ?? null,
      });
    }
    byAgent.set(identity, list);
  }
  return byAgent;
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'ERROR', 'TIMEOUT', 'LIMIT_REACHED']);

/**
 * The execution view.
 *
 * Reads as a control room's status board: one line per agent, the plan's cases
 * beneath it in matrix order, and each case marked with what was recorded. The
 * marks are `✓` for a case whose run reached a terminal status, `→` for one
 * whose run is still going, and `○` for one that has not started.
 */
export function ExecutionView({
  experimentLabel,
  plan,
  recorded,
  recording,
  elapsedSeconds,
}: {
  experimentLabel: string;
  plan: Map<string, PlannedCaseProgress[]>;
  recorded: readonly RecordedRun[];
  recording: boolean;
  elapsedSeconds: number;
}) {
  const agentEntries = [...plan.entries()];
  const totalPlanned = agentEntries.reduce((sum, [, cases]) => sum + cases.length, 0);
  const totalRecorded = finishedCaseCount(plan);

  return (
    <Panel
      title="Test in progress"
      description={
        <>
          Experiment <span className="font-mono">{experimentLabel}</span>. Cases are marked from the
          runs this test has actually recorded — a case shows as started only once its run exists,
          and its agent is the one the run recorded for itself.
        </>
      }
      source="trace"
      sourceKind="fact"
      action={
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={recording ? 'info' : 'warn'}>
            {recording ? 'recording' : 'not observing'}
          </StatusChip>
          <span className="font-mono text-[11px] text-muted-foreground">
            {elapsedSeconds}s elapsed
          </span>
        </div>
      }
    >
      <div className="space-y-7">
        <div className="space-y-3">
          <ProgressReading completed={totalRecorded} total={totalPlanned} label="Cases recorded" />
          <p className="text-[11px] text-muted-foreground">
            {recorded.length} run(s) created since this test started. Agents run in canonical order,
            so a case belonging to the second agent appears only after the first agent has finished
            every case.
          </p>
        </div>

        {!recording ? (
          <Notice>
            Progress could not be observed for this test, so no case is marked as started. The test
            is still running; when it finishes, its result will be shown in full.
          </Notice>
        ) : null}

        {agentEntries.map(([identity, cases]) => {
          const done = cases.filter((entry) => entry.status && TERMINAL.has(entry.status)).length;
          const running = cases.filter(
            (entry) =>
              entry.status !== null && entry.status !== undefined && !TERMINAL.has(entry.status),
          ).length;
          return (
            <div key={identity} className="space-y-3">
              <ProgressReading completed={done} total={cases.length} label={identity} />
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {cases.map((entry) => {
                  const mark =
                    entry.status && TERMINAL.has(entry.status) ? '✓' : entry.status ? '→' : '○';
                  const label = scenarioLabel(entry.scenarioId);
                  return (
                    <span
                      key={entry.key}
                      className="inline-flex items-baseline gap-1.5 font-mono text-[11px] text-muted-foreground"
                      title={
                        entry.runId
                          ? `${label} · seed ${entry.seed} · run ${entry.runId} · ${entry.status}`
                          : `${label} · seed ${entry.seed} · no run recorded yet`
                      }
                    >
                      <span aria-hidden className="text-foreground">
                        {mark}
                      </span>
                      <span>{label}</span>
                    </span>
                  );
                })}
              </div>
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                {done} finished
                {running > 0 ? ` · ${running} running` : ''} · {cases.length - done - running} not
                started
              </p>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/**
 * How many planned cases have a recorded run whose status is terminal.
 *
 * Counts records, never the clock: the numerator moves only when a run exists
 * and has stopped, which is the whole difference between this and a progress bar
 * that claims work happened.
 */
function finishedCaseCount(plan: Map<string, PlannedCaseProgress[]>): number {
  let count = 0;
  for (const cases of plan.values()) {
    for (const entry of cases) {
      if (entry.status && TERMINAL.has(entry.status)) count += 1;
    }
  }
  return count;
}
