// @polsia:user-owned — server shell for the client-fetched simulation workspace.

import type { Metadata } from 'next';
import { SimulationRunStarter } from '@/components/custom/simulation-run-starter';

export const metadata: Metadata = {
  title: 'Simulation lab',
  description: 'Start and replay deterministic resource-management runs.',
};

export default function SimulationsPage() {
  return <SimulationRunStarter />;
}
