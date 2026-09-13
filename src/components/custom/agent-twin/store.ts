// @polsia:user-owned — what this browser remembers about a test it ran.
//
// A comparison report is deliberately not persisted. Nothing about it is state:
// the runs it was derived from are the evidence, and a stored copy of a report
// could only drift from the evidence it claims to summarise. So a result lives
// exactly as long as the request that produced it, and a page that wants to show
// it again has to hold on to it itself.
//
// This module is that holding place, and it is deliberately the smallest one
// possible: a browser-session store, clearly labelled as a browser-session
// store. Nothing here is shared, nothing survives the tab, and nothing is ever
// presented as a record. When the store is empty, a caller must say so and offer
// the persisted runs instead — which is exactly what the result page does.
//
// Every read and write is guarded. A private window, a cleared site store or a
// blocked storage accessor throws rather than returning nothing, and a test
// result is not worth a broken page.

import type { ComparisonReport } from '@/lib/comparison/types';

const REPORT_PREFIX = 'agent-twin:report:';
const MODELS_KEY = 'agent-twin:models-used';

/** One report this browser produced, with the time it was produced. */
export interface StoredReport {
  report: ComparisonReport;
  /** When this browser received it. Not part of the report, and labelled as such. */
  storedAt: string;
}

function storage(): Storage | null {
  try {
    // Access itself can throw when site data is blocked.
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Keep one report for the rest of this browser session. */
export function storeReport(report: ComparisonReport): void {
  const store = storage();
  if (!store) return;
  try {
    const entry: StoredReport = { report, storedAt: new Date().toISOString() };
    store.setItem(`${REPORT_PREFIX}${report.experiment.key}`, JSON.stringify(entry));
  } catch {
    // A report too large for the store is a session that cannot re-open it, not
    // a session that cannot read the one on screen.
  }
}

/** Read back a report this browser produced, or `null` if it never did. */
export function readReport(experimentKey: string): StoredReport | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(`${REPORT_PREFIX}${experimentKey}`);
    if (!raw) return null;
    return JSON.parse(raw) as StoredReport;
  } catch {
    return null;
  }
}

/** Every report this browser still holds for one experiment, newest first. */
export function readReportsForExperiment(experimentId: string): StoredReport[] {
  const store = storage();
  if (!store) return [];
  const entries: StoredReport[] = [];
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (!key?.startsWith(REPORT_PREFIX)) continue;
      const raw = store.getItem(key);
      if (!raw) continue;
      const entry = JSON.parse(raw) as StoredReport;
      if (entry?.report?.experiment?.id === experimentId) entries.push(entry);
    }
  } catch {
    return entries;
  }
  return entries.sort((left, right) => right.storedAt.localeCompare(left.storedAt));
}

/**
 * The models this browser has asked for, newest first.
 *
 * Not a catalogue and not a registry: a record of what this browser has already
 * typed, offered back so an operator does not have to remember a model slug
 * between two runs. It is labelled as exactly that wherever it is shown.
 */
export function rememberModels(models: readonly string[]): void {
  const store = storage();
  if (!store) return;
  try {
    const existing = readModels();
    const merged = [...new Set([...models, ...existing])].slice(0, 12);
    store.setItem(MODELS_KEY, JSON.stringify(merged));
  } catch {
    // Nothing about a suggestion list is worth failing a run over.
  }
}

/** The models this browser has used before, newest first. */
export function readModels(): string[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(MODELS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}
