// @polsia:user-owned — the Operator destination.
//
// A page in the existing console rather than an application beside it: the same
// shell, the same navigation, the same panels. The operator is a new way to ask
// this product's question, not a second product.
//
// The page is a thin mount. Everything it renders — the request form, the plan,
// the trace, the report — is in the client console component, because the whole
// view is one request-scoped conversation with the server and splitting it
// across a server boundary would only mean re-deriving state that already lives
// in one place.

import type { Metadata } from 'next';
import { OperatorConsole } from '@/components/custom/agent-twin/operator';

export const metadata: Metadata = {
  title: 'Operator · Agent Twin',
  description:
    'Hand an objective to an autonomous operator that plans a test, runs it through the deterministic engines, and reports whether the agent is ready to deploy.',
};

export default function OperatorPage() {
  return <OperatorConsole />;
}
