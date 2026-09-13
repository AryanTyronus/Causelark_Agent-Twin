//
// The segment is the experiment's id, so a result is addressable by the test it
// came from rather than by an opaque run identifier. In Next 16 a dynamic
// segment arrives as a promise, hence the await.

import type { Metadata } from 'next';
import { TestResult } from '@/components/custom/agent-twin/test-result';

export const metadata: Metadata = {
  title: 'Test result',
  description:
    'The head-to-head result of one Agent Twin experiment: who performed better, under what conditions, and what went wrong.',
};

export default async function TestResultPage({
  params,
}: {
  params: Promise<{ comparisonId: string }>;
}) {
  const { comparisonId } = await params;
  return <TestResult experimentId={comparisonId} />;
}
