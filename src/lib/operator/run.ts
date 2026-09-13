// @polsia:user-owned — one operator request, from a validated request to a run state.
//
// The split from `operator.ts` is deliberate. `operator.ts` knows about Strands:
// an `Agent`, a `Model`, an invocation and its limits. This file knows about a
// *request*: which agent the caller named, whether an execution was authorised,
// and which failures are the caller's to fix rather than findings to report.
//
// The identity is a parameter, not something resolved here, because the only
// correct place to resolve it is the authenticated session — and putting it in
// the signature is what makes it impossible to call this without one.
//
// Everything this file can refuse, it refuses *before* the operator is invoked.
// A request naming an agent this deployment cannot run, or asking to execute
// without an authorisation, must cost nothing: not a model call, not a plan, not
// a run.

import 'server-only';

import { deploymentAgentCatalog } from '@/lib/business/agent-catalog';
import { runOperator } from './operator';
import { OperatorError, type OperatorRunRequest, type OperatorRunState } from './types';

/**
 * Serve one operator request.
 *
 * Throws `OperatorError` for the four failures that are the caller's: an
 * unconfigured deployment, an agent key that is not in the catalogue, an
 * execution asked for without an authorisation, and an operator that could not
 * start. A benchmark that failed, a case that produced no evidence, a tool call
 * that was refused — none of those throw, because none of them is an error.
 */
export async function runOperatorForUser(
  ownerId: string,
  request: OperatorRunRequest,
): Promise<OperatorRunState> {
  const catalogue = deploymentAgentCatalog();

  if (catalogue.agents.length === 0)
    throw new OperatorError(
      'NO_AGENT_CONFIGURED',
      catalogue.configurationNotice ??
        'This deployment has no agent configuration that resolves, so there is no agent for the operator to test.',
    );

  if (request.agentKey) {
    const agent = catalogue.agents.find((candidate) => candidate.key === request.agentKey);
    if (!agent)
      throw new OperatorError(
        'UNKNOWN_AGENT',
        `No agent in this deployment's catalogue has the key "${request.agentKey}". Available keys: ${catalogue.agents.map((candidate) => candidate.key).join(', ')}.`,
      );
  }

  // The authorisation gate. An execution that spends real provider capacity is
  // not something a caller may ask for by sending `mode: 'execute'`; it must
  // present the fingerprint of the plan a person was shown. The tool that runs
  // the benchmark checks the same value against the plan the operator actually
  // committed to — this check only ensures the request carried one at all.
  if (request.mode === 'execute' && !request.authorizedPlanFingerprint)
    throw new OperatorError(
      'UNAUTHORIZED_MODE',
      'An execution must present the fingerprint of the test plan it authorises. Run the same request in preview mode first, show the plan to a person, and send its fingerprint back.',
    );

  return runOperator({
    ownerId,
    objective: request.objective,
    mode: request.mode,
    agentKey: request.agentKey ?? null,
    authorizedPlanFingerprint: request.authorizedPlanFingerprint ?? null,
  });
}
