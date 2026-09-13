//
// The benchmark id is the path segment and the version is an optional query
// parameter, because a benchmark id is stable while its versions accumulate.
// `useSearchParams` needs a Suspense boundary in Next 16, so the boundary lives
// here rather than inside the view.

import type { Metadata } from 'next';
import { Suspense } from 'react';
import { BenchmarkDetailView } from '@/components/custom/agent-twin/benchmark-detail';
import { Panel, PanelSkeleton } from '@/components/custom/agent-twin/ui';

export const metadata: Metadata = {
  title: 'Benchmark',
  description:
    'One Agent Twin benchmark in full: its environment, its conditions at pinned versions, its seeds, its robustness formula and its limits.',
};

export default async function BenchmarkPage({
  params,
}: {
  params: Promise<{ benchmarkId: string }>;
}) {
  const { benchmarkId } = await params;
  return (
    <Suspense
      fallback={
        <Panel title="Benchmark">
          <PanelSkeleton lines={6} label="Loading the benchmark definition" />
        </Panel>
      }
    >
      <BenchmarkDetailView benchmarkId={benchmarkId} />
    </Suspense>
  );
}
