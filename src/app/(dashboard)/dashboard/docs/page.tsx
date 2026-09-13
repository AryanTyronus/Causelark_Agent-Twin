// @polsia:user-owned — the reference for the product experience.
//
// The console's own documentation: what a test is, what each engine does, what
// the interface promises about provenance, and what it deliberately refuses to
// do. It contains no credential, no endpoint that a reader could not open
// themselves, and no claim the code does not make.

import type { Metadata } from 'next';
import Link from 'next/link';
import { Panel } from '@/components/custom/agent-twin/ui';

export const metadata: Metadata = {
  title: 'Documentation',
  description:
    'How Agent Twin works: running a test, reading a comparison, inspecting evidence, and analysing a decision counterfactually.',
};

const SECTIONS = [
  {
    id: 'what',
    title: 'What Agent Twin is',
    body: [
      'Agent Twin is a crash-test facility for autonomous agents. It puts an agent inside a controlled digital environment, gives it an objective, and lets it act — then measures what it actually did rather than what it was asked to do.',
      'The environment is deterministic given a seed: the same seed and the same actions produce the same world. The agent is not deterministic, and the product never pretends otherwise. That asymmetry is the point — the world is held still so the agent’s behaviour is the only moving part.',
    ],
  },
  {
    id: 'test',
    title: 'Running a test',
    body: [
      'A test names the agents to compare and the benchmark to run them through. A benchmark fixes the environment, the conditions at pinned versions, and the seeds. Because those are fixed, everything except the agent is held equal.',
      'A test drives real model turns. It takes real time, and it is reported as it happens by reading the runs it creates — never by a progress bar that moves on a timer. If a case has not recorded a run yet, it is shown as not started, because that is what is true.',
    ],
  },
  {
    id: 'evidence',
    title: 'Evidence, and where it comes from',
    body: [
      'Every number in the console is produced by a server-side engine and displayed unchanged. The interface does not re-implement an evaluation formula, a robustness formula, a verdict rule or a counterfactual calculation. There is exactly one implementation of each, and it is the one that runs.',
      'A panel that carries a source chip says which engine produced it: evaluation, benchmark, trace, counterfactual, or the deployment’s own configuration. A fact is recorded evidence — an action that was rejected, a run that terminated, a count that exists. A derived reading is a computed figure — a score, a rate, a robustness retention. The distinction is shown because “the agent scored 61” and “the agent attempted to allocate beyond its budget” are different kinds of claim.',
    ],
  },
  {
    id: 'comparison',
    title: 'How comparison works',
    body: [
      'A comparison runs two or more agents through the same benchmark matrix — the same conditions, at the same versions, at the same seeds, against the same objective and the same tool set. Each run is scored by the evaluation engine, and the comparison engine then decides a verdict against a declared rule.',
      'The verdict is deterministic and has exactly one of three outcomes: one agent wins, the agents tie, or the evidence is insufficient to say. “Insufficient evidence” is a real result, not an error — it is what the engine returns when too few cases produced comparable runs for a difference to mean anything.',
      'The reasoning is shown alongside the outcome: which metric decided it, which way that metric is read, and the ladder of discriminators the rule walked to get there. The interface does not write its own explanation of a result.',
    ],
  },
  {
    id: 'robustness',
    title: 'Robustness',
    body: [
      'Robustness measures how well an agent retains its baseline performance when the environment changes. The baseline condition is scored, every other condition is scored the same way, and the figure is what was retained.',
      'Where the evidence cannot support a figure the engine reports it as unavailable, with a reason. The console shows that reason. It never converts an unavailable measurement into a zero, because a zero is a claim and an absence is not.',
    ],
  },
  {
    id: 'counterfactual',
    title: 'Counterfactual analysis',
    body: [
      'A run is a sequence of decisions. The counterfactual engine takes one of them and asks what the run would have looked like had the agent taken a different valid action at that point — same world, same state, same continuation policy.',
      'For each alternative it reports the outcome, the delta against what actually happened, and whether the run’s terminal outcome would have flipped. The three policies the analysis was run under are named on the analysis itself, so a reader can see what was held constant.',
      'Only conclusions the engine returns are displayed. The interface never asks a model to explain a result, because an explanation produced by a model is another model’s opinion, not evidence about the agent under test.',
    ],
  },
  {
    id: 'replay',
    title: 'Replay',
    body: [
      'Every run records the events it produced, in order, as it produced them. Replay shows that sequence — observation, decision, action, environment transition — with the raw payload one expansion away rather than on screen by default.',
      'Replay reads the run’s own record. It is not a reconstruction, and it is not a summary of one.',
    ],
  },
  {
    id: 'data',
    title: 'What is stored, and what is not',
    body: [
      'Runs are persisted and are the durable evidence. A comparison report is not persisted: it is a pure function of the runs it was derived from, so a stored copy could only drift from its own evidence. A result therefore lives in the browser session that produced it, and the console says so on the page.',
      'Agent configurations are not stored either. There is no agent registry: what this deployment can run is derived from its provider configuration at read time, and a model’s identity is the model, never a credential.',
    ],
  },
  {
    id: 'running-locally',
    title: 'Running it locally',
    body: [
      'The deployment needs a database and one configured provider. Provider credentials are read from the server environment only — the browser never receives them, and no endpoint returns them.',
      'The console is fully usable without a model provider for everything except driving a run: the catalogues, benchmark specifications, agent configuration view, and every previously recorded run are readable without inference. A test that cannot reach a provider reports its cases as unavailable rather than inventing a score for them.',
    ],
  },
];

export default function DocsPage() {
  return (
    <div className="space-y-6">
      <div>
        <p className="text-eyebrow">Documentation</p>
        <h1 className="mt-3 font-display text-h2">How Agent Twin works</h1>
        <p className="mt-3 max-w-prose text-small leading-relaxed text-muted-foreground">
          The product’s own reference. It describes what the engines do and what the interface
          promises — not how the code is arranged.
        </p>
      </div>

      <nav aria-label="Sections" className="flex flex-wrap gap-x-4 gap-y-2">
        {SECTIONS.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="text-small text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            {section.title}
          </a>
        ))}
      </nav>

      <div className="space-y-6">
        {SECTIONS.map((section) => (
          <Panel key={section.id} id={section.id} title={section.title}>
            <div className="space-y-3">
              {section.body.map((paragraph) => (
                <p
                  key={paragraph}
                  className="max-w-prose text-small leading-relaxed text-muted-foreground"
                >
                  {paragraph}
                </p>
              ))}
            </div>
          </Panel>
        ))}
      </div>

      <Panel title="Where to go next">
        <ul className="space-y-2 text-small">
          <li>
            <Link href="/dashboard/tests" className="underline underline-offset-4">
              Run a test
            </Link>{' '}
            — compare two agents under identical conditions.
          </li>
          <li>
            <Link href="/dashboard/benchmarks" className="underline underline-offset-4">
              Benchmarks
            </Link>{' '}
            — the standardised tests, and what each one fixes.
          </li>
          <li>
            <Link href="/dashboard/agents" className="underline underline-offset-4">
              Agents
            </Link>{' '}
            — what this deployment can actually run.
          </li>
          <li>
            <Link href="/dashboard/simulations" className="underline underline-offset-4">
              Recorded runs
            </Link>{' '}
            — the persisted evidence, and the run inspector.
          </li>
        </ul>
      </Panel>
    </div>
  );
}
