// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getSimulationOptions } from '@/lib/business/simulation';
import {
  SimulationActionInput,
  SimulationOptions,
  SimulationRunList,
  SimulationStartInput,
} from '@/lib/contracts/simulation';

describe('simulation contracts', () => {
  it('accepts supported start and action payloads', () => {
    expect(
      SimulationStartInput.safeParse({
        environmentKey: 'resource-routing',
        objectiveKey: 'complete-delivery',
        seed: 9182,
      }).success,
    ).toBe(true);
    expect(
      SimulationActionInput.safeParse({ type: 'allocate', resource: 'water', amount: 2 }).success,
    ).toBe(true);
  });

  it('rejects unsupported starts and malformed actions', () => {
    expect(
      SimulationStartInput.safeParse({
        environmentKey: 'unknown',
        objectiveKey: 'complete-delivery',
        seed: 1,
      }).success,
    ).toBe(false);
    expect(SimulationActionInput.safeParse({ type: 'allocate', amount: 0 }).success).toBe(false);
  });

  it('parses the catalogue and response envelopes', () => {
    expect(SimulationOptions.safeParse(getSimulationOptions()).success).toBe(true);
    expect(SimulationRunList.safeParse({ runs: [] }).success).toBe(true);
    expect(SimulationRunList.safeParse({ runs: [{ id: 'missing-fields' }] }).success).toBe(false);
  });
});
