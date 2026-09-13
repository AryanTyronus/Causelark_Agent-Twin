//
// The flow itself lives in the client component; this file is the server-rendered
// title and metadata around it, so the route has a stable name in the browser and
// in the sitemap without shipping the flow's JavaScript for a page nobody opened.

import type { Metadata } from 'next';
import { TestRunner } from '@/components/custom/agent-twin/test-runner';

export const metadata: Metadata = {
  title: 'Run a test',
  description:
    'Compare autonomous agents under identical conditions: same environment, same scenarios, same seeds, same objective, same tools.',
};

export default function TestsPage() {
  return (
    <div className="space-y-6">
      <div>
        <p className="text-eyebrow">Test</p>
        <h1 className="mt-3 font-display text-h2">Run a test</h1>
        <p className="mt-3 max-w-prose text-small leading-relaxed text-muted-foreground">
          Choose the agents, choose the benchmark, review the conditions, run. The experiment holds
          everything except the agent equal, so a difference in the result is a difference in the
          agent.
        </p>
      </div>
      <TestRunner />
    </div>
  );
}
