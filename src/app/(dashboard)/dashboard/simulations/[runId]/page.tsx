import type { Metadata } from 'next';
import { AgentTwinRunView } from '@/components/custom/agent-twin-run-view';

export const metadata: Metadata = {
  title: 'Agent Twin run inspector',
  description:
    'Inspect persisted observations, tool calls, validated transitions, metrics, and replay frames.',
};

export default async function SimulationRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return <AgentTwinRunView key={runId} runId={runId} />;
}
