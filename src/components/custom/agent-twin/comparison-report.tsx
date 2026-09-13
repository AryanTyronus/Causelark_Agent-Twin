// @polsia:user-owned — the comparison result screen.
//
// This is the screen that has to answer four questions without the reader
// knowing anything about the codebase: who performed better, why, under what
// conditions, and what went wrong.
//
// It answers all four from one source. Every number, verdict word, formula name
// and sentence on this page arrives in the `ComparisonReport` the run endpoint
// returned; the page chooses what to place beside what and writes nothing of its
// own. It does not re-implement an evaluation weight, a robustness formula, a
// comparison rule or a verdict — if a number is not in the report, this page
// does not show it.
//
// Three presentational rules the whole screen holds to:
//
//   A missing number is not a zero. Every nullable field renders as an explicit
//   absence, because the engines use `null` for "this evidence cannot support a
//   value" and printing `0` there would report a measurement nobody made.
//
//   Status and direction are never carried by colour alone. Every reading has
//   its word, and every bar has its number as text.
//
//   A claim states its source. Numbers from the comparison engine, the benchmark
//   engine, the evaluation engine and the recorded trace are distinguished,
//   because "the agent scored 62" and "the agent's actions were refused 4 times"
//   are different kinds of statement.

'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ComparisonAgent, ComparisonReport } from '@/lib/comparison/types';
import { CaseEvidence } from './case-evidence';
import {
  failureSummary,
  formatMetric,
  formatMetricDelta,
  formatRatio,
  formatScore,
  metricDescription,
  metricDirection,
  metricLabel,
  scenarioLabel,
} from './format';
import { EmptyState, Fact, Notice, Panel, ScoreBar, SourceChip, StatusChip } from './ui';

/** The failure classes that describe behaviour, as against execution. */
const BEHAVIOUR_FAILURES = new Set(['taskFailure', 'safetyViolation', 'invalidActions']);

const FAILURE_LABELS: Record<string, string> = {
  taskFailure: 'Cases where the objective was not reached',
  safetyViolation: 'Cases that exceeded the risk threshold',
  invalidActions: 'Cases with a refused action',
  providerFailures: 'Cases where the provider faulted',
  toolFailures: 'Cases where a tool call failed',
  timeouts: 'Cases that ran out of turns or steps',
};

export function ComparisonReportView({ report }: { report: ComparisonReport }) {
  const agents = report.agents;
  const labels = agents.map((agent) => agent.identity);
  const verdict = report.verdict;
  const winner = agents.find((agent) => agent.key === verdict.winner) ?? null;
  const comparisonComplete =
    report.execution.executedCaseCount >= report.execution.plannedCaseCount;

  return (
    <div className="space-y-6">
      <Panel
        title={report.experiment.name}
        description={report.experiment.description}
        source="benchmark"
        sourceKind="fact"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Experiment" value={`${report.experiment.id}@${report.experiment.version}`} />
          <Fact
            label="Benchmark"
            value={`${report.experiment.benchmarkId}@${report.experiment.benchmarkVersion}`}
            hint={report.experiment.benchmarkName}
          />
          <Fact label="Environment" value={report.experiment.environmentKey} />
          <Fact label="Objective" value={report.experiment.objectiveKey} />
          <Fact label="Scenarios" value={report.experiment.scenarios.length} />
          <Fact
            label="Seeds"
            value={report.experiment.seeds.join(', ')}
            hint={
              report.experiment.seeds.join(',') === report.experiment.declaredSeeds.join(',')
                ? undefined
                : `Benchmark declares ${report.experiment.declaredSeeds.join(', ')}`
            }
          />
          <Fact
            label="Cases executed"
            value={`${report.execution.executedCaseCount} / ${report.execution.plannedCaseCount}`}
            hint={`${report.experiment.caseCountPerAgent} per agent`}
          />
          <Fact
            label="Agents compared"
            value={`${report.execution.comparedAgentCount} of ${report.experiment.agentCount}`}
            hint={
              report.execution.unavailableAgentCount > 0
                ? `${report.execution.unavailableAgentCount} produced no comparable evidence`
                : undefined
            }
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <SourceChip source="benchmark" kind="fact" />
          <SourceChip source="evaluation" />
          <SourceChip source="counterfactual" />
          <span className="font-mono text-[11px] text-muted-foreground">
            methodology {report.methodology.comparison} · verdict rule{' '}
            {report.methodology.verdictRule}
          </span>
        </div>
      </Panel>

      <VerdictPanel report={report} winner={winner} labels={labels} complete={comparisonComplete} />

      <HeadToHeadPanel report={report} />

      <MetricTablePanel report={report} />

      <ScenarioPanel report={report} />

      <RobustnessPanel report={report} />

      <FailurePanel report={report} />

      <AgentsEvidencePanel report={report} />
    </div>
  );
}

/**
 * The verdict, in the rule's own terms.
 *
 * The wording is the engine's. `decidedBy` names the discriminator that settled
 * it, the margin is the gap that settled it, and the rung table shows what each
 * discriminating metric saw — including the rungs that decided nothing, so a
 * reader can see the rule was walked rather than trust a conclusion.
 */
function VerdictPanel({
  report,
  winner,
  labels,
  complete,
}: {
  report: ComparisonReport;
  winner: ComparisonAgent | null;
  labels: string[];
  complete: boolean;
}) {
  const verdict = report.verdict;
  const tone = verdict.outcome === 'WINNER' ? 'ok' : verdict.outcome === 'TIE' ? 'info' : 'warn';
  const headline =
    verdict.outcome === 'WINNER'
      ? `${winner?.identity ?? verdict.winnerIdentity ?? 'One agent'} performed better under these conditions`
      : verdict.outcome === 'TIE'
        ? 'No difference the declared rule could separate'
        : 'Insufficient evidence to name a winner';

  return (
    <Panel
      id="verdict"
      title="Verdict"
      description="Decided by the comparison engine's declared discriminator order, over the evidence the two agents' runs produced. It is a deterministic rule, not a judgement."
      source="evaluation"
      action={<StatusChip tone={tone}>{verdict.outcome.replaceAll('_', ' ')}</StatusChip>}
    >
      <div className="space-y-5">
        <p className="font-display text-h4 leading-snug">{headline}</p>
        <p className="max-w-prose text-small leading-relaxed text-muted-foreground">
          {verdict.reason}
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <Fact
            label="Decided by"
            value={verdict.decidedBy ? metricLabel(verdict.decidedBy) : null}
            hint={verdict.decidedBy ? metricDescription(verdict.decidedBy) : undefined}
          />
          <Fact
            label="Winning agent"
            value={verdict.outcome === 'WINNER' ? (winner?.identity ?? null) : null}
            hint={
              verdict.outcome === 'WINNER'
                ? (winner?.agent.model ?? undefined)
                : 'No agent is named unless the rule names one.'
            }
          />
          <Fact
            label="Rule"
            value={report.methodology.verdictRule}
            hint={`Discriminators consulted in order: ${report.methodology.discriminators
              .map((metric) => metricLabel(metric))
              .join(' → ')}`}
          />
        </div>

        {!complete ? (
          <Notice>
            <span className="font-medium text-foreground">Some cases produced no run. </span>
            {report.execution.executedCaseCount} of {report.execution.plannedCaseCount} planned
            cases were executed. The verdict is stated over the evidence that exists, not over the
            evidence the experiment intended to collect.
          </Notice>
        ) : null}

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Discriminator</TableHead>
                <TableHead>In contention</TableHead>
                <TableHead>Best value</TableHead>
                <TableHead>Margin</TableHead>
                <TableHead className="w-32">Effect</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {verdict.levels.map((level) => (
                <TableRow key={level.metric}>
                  <TableCell>
                    <p className="text-small">{metricLabel(level.metric)}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                      {metricDirection(level.metric)} is better
                    </p>
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">
                    {level.contenders
                      .map((key) => labels[report.agents.findIndex((a) => a.key === key)] ?? key)
                      .join(', ')}
                  </TableCell>
                  <TableCell className="font-mono text-small tabular-nums">
                    {formatMetric(level.metric, level.value)}
                  </TableCell>
                  <TableCell className="font-mono text-small tabular-nums">
                    {formatMetric(level.metric, level.margin)}
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-[11px]">
                      {level.decided ? 'decided the verdict' : 'no separation'}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </Panel>
  );
}

/** Two agents, metric by metric, with the delta and which side won each. */
function HeadToHeadPanel({ report }: { report: ComparisonReport }) {
  if (report.headToHead.length === 0) return null;
  const labelFor = (key: string) =>
    report.agents.find((agent) => agent.key === key)?.identity ?? key;
  return (
    <Panel
      title="Head to head"
      description="Each metric the comparison reports, one agent against the other. Direction is the comparison engine's own declaration: a lower rejected-action rate or mean risk is the better reading, and steps, budget spent and budget share are stated without a preference because they are only meaningful beside the result they bought."
      source="evaluation"
    >
      <div className="space-y-8">
        {report.headToHead.map((pair) => (
          <div key={`${pair.left}|${pair.right}`} className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <p className="font-mono text-small">
                {labelFor(pair.left)} <span className="text-muted-foreground">vs</span>{' '}
                {labelFor(pair.right)}
              </p>
              <p className="font-mono text-[11px] text-muted-foreground">
                metrics won · {labelFor(pair.left)} {pair.leftWins} — {pair.rightWins}{' '}
                {labelFor(pair.right)}
              </p>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Metric</TableHead>
                    <TableHead className="text-right">{labelFor(pair.left)}</TableHead>
                    <TableHead className="text-right">{labelFor(pair.right)}</TableHead>
                    <TableHead className="text-right">Difference</TableHead>
                    <TableHead className="w-32">Better</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pair.metrics.map((metric) => (
                    <TableRow key={metric.metric}>
                      <TableCell>
                        <p className="text-small">{metricLabel(metric.metric)}</p>
                        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                          {metricDirection(metric.metric) === 'neutral'
                            ? 'neutral — neither better nor worse'
                            : `${metricDirection(metric.metric)} is better`}
                        </p>
                      </TableCell>
                      <TableCell className="text-right font-mono text-small tabular-nums">
                        {formatMetric(metric.metric, metric.left)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-small tabular-nums">
                        {formatMetric(metric.metric, metric.right)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-small tabular-nums">
                        {formatMetricDelta(metric.metric, metric.delta)}
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-[11px]">
                          {metric.winner === null
                            ? metricDirection(metric.metric) === 'neutral'
                              ? 'not scored'
                              : 'tied'
                            : metric.winner === 'left'
                              ? labelFor(pair.left)
                              : labelFor(pair.right)}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** Every reported metric, across every agent in the experiment. */
function MetricTablePanel({ report }: { report: ComparisonReport }) {
  if (report.agents.length < 2) return null;
  const labelFor = (key: string) =>
    report.agents.find((agent) => agent.key === key)?.identity ?? key;
  return (
    <Panel
      title="Measured outcomes"
      description="Every metric the comparison reports, per agent, as the comparison engine computed it from each agent's own benchmark report. A metric nobody could derive is stated as not recorded rather than as zero."
      source="evaluation"
    >
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Metric</TableHead>
              {report.agents.map((agent) => (
                <TableHead key={agent.key} className="text-right">
                  {agent.identity}
                </TableHead>
              ))}
              <TableHead className="w-24">Best</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.metrics.map((entry) => (
              <TableRow key={entry.metric}>
                <TableCell>
                  <p className="text-small">{metricLabel(entry.metric)}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {metricDirection(entry.metric) === 'neutral'
                      ? 'neutral — stated without a preference'
                      : `${metricDirection(entry.metric)} is better`}
                  </p>
                </TableCell>
                {report.agents.map((agent, index) => (
                  <TableCell
                    key={agent.key}
                    className="text-right font-mono text-small tabular-nums"
                  >
                    {formatMetric(entry.metric, entry.values[index] ?? null)}
                  </TableCell>
                ))}
                <TableCell className="font-mono text-[11px]">
                  {metricDirection(entry.metric) === 'neutral'
                    ? 'not scored'
                    : entry.leaders.length === 0
                      ? 'nobody recorded'
                      : entry.tied
                        ? `tied · ${entry.leaders.map(labelFor).join(', ')}`
                        : labelFor(entry.leaders[0] ?? '')}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Panel>
  );
}

/** One row per scenario, each agent's score under that condition. */
function ScenarioPanel({ report }: { report: ComparisonReport }) {
  const comparable = report.scenarios.filter((scenario) =>
    scenario.scores.some((score) => score !== null),
  );
  return (
    <Panel
      id="scenarios"
      title="Scenario performance"
      description="The same scenario, run once per agent under identical conditions. A scenario where the two agents diverge is the experiment working: it is where the agent, and not the world, made the difference."
      source="benchmark"
    >
      {comparable.length === 0 ? (
        <EmptyState
          title="No scenario produced a score"
          description="None of this experiment's cases produced a verdict the evaluation engine could compute, so there is no per-scenario comparison to show."
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Condition</TableHead>
                {report.agents.map((agent) => (
                  <TableHead key={agent.key} className="text-right">
                    {agent.identity}
                  </TableHead>
                ))}
                <TableHead className="text-right">Spread</TableHead>
                <TableHead className="w-40">Better here</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.scenarios.map((scenario) => (
                <TableRow key={`${scenario.scenarioId}@${scenario.scenarioVersion}`}>
                  <TableCell>
                    <p className="text-small">{scenarioLabel(scenario.scenarioId)}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                      v{scenario.scenarioVersion}
                      {scenario.isBaseline ? ' · baseline condition' : ' · perturbed condition'}
                    </p>
                  </TableCell>
                  {report.agents.map((agent, index) => (
                    <TableCell
                      key={agent.key}
                      className="text-right font-mono text-small tabular-nums"
                    >
                      {formatScore(scenario.scores[index] ?? null)}
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-mono text-small tabular-nums">
                    {formatScore(scenario.spread)}
                  </TableCell>
                  <TableCell className="font-mono text-[11px]">
                    {scenario.leaders.length === 0
                      ? 'nobody recorded'
                      : scenario.tied
                        ? 'tied'
                        : (report.agents.find((agent) => agent.key === scenario.leaders[0])
                            ?.identity ?? '—')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Panel>
  );
}

/**
 * Robustness, using the benchmark engine's own report.
 *
 * The explanation of what robustness measures is stated once, and the numbers
 * come straight from each agent's `RobustnessReport`: baseline, worst scenario,
 * mean and worst degradation, per-scenario retention, and the engine's formula
 * name. The interface does not compute a second robustness figure — the number
 * and the formula it was computed under both come from the engine that produced
 * them.
 */
function RobustnessPanel({ report }: { report: ComparisonReport }) {
  return (
    <Panel
      id="robustness"
      title="Robustness"
      description="Robustness measures how well an agent retains baseline performance when environmental conditions change. Each perturbed scenario is compared against the baseline condition by the benchmark engine's own formula, and retention is that comparison."
      source="benchmark"
      action={
        <span className="font-mono text-[11px] text-muted-foreground">
          {report.robustness.formula}
        </span>
      }
    >
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {report.agents.map((agent, index) => (
            <div key={agent.key} className="rounded-sm border border-border p-4">
              <p className="font-mono text-small">{agent.identity}</p>
              <div className="mt-3 space-y-2.5">
                <ScoreBar
                  label="Robustness score"
                  value={agent.report?.robustness.robustnessScore ?? null}
                  detail={formatRatio(agent.report?.robustness.robustnessScore ?? null)}
                  tone="positive"
                />
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <Fact
                    label="Baseline score"
                    value={agent.report ? formatScore(agent.report.robustness.baselineScore) : null}
                  />
                  <Fact
                    label="Worst scenario"
                    value={
                      agent.report ? formatScore(agent.report.robustness.worstScenarioScore) : null
                    }
                    hint={agent.report?.robustness.worstScenarioId ?? undefined}
                  />
                  <Fact
                    label="Mean degradation"
                    value={
                      agent.report ? formatScore(agent.report.robustness.averageDegradation) : null
                    }
                  />
                  <Fact
                    label="Worst degradation"
                    value={
                      agent.report ? formatScore(agent.report.robustness.worstDegradation) : null
                    }
                  />
                </div>
              </div>
              {report.robustness.unavailableReasons[index] ? (
                <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
                  {report.robustness.unavailableReasons[index]}
                </p>
              ) : null}
            </div>
          ))}
        </div>

        {report.agents.some((agent) => (agent.report?.scenarios.length ?? 0) > 0) ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Condition</TableHead>
                  {report.agents.map((agent) => (
                    <TableHead key={agent.key} className="text-right">
                      {agent.identity} · retention
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {baselineScenarioIds(report).map((scenarioId) => (
                  <TableRow key={scenarioId}>
                    <TableCell className="text-small">{scenarioLabel(scenarioId)}</TableCell>
                    {report.agents.map((agent) => {
                      const row = agent.report?.scenarios.find(
                        (entry) => entry.scenarioId === scenarioId,
                      );
                      return (
                        <TableCell
                          key={agent.key}
                          className="text-right font-mono text-small tabular-nums"
                        >
                          {row ? formatRatio(row.retention) : 'not recorded'}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}

        <Notice>
          A robustness score of 100 means every perturbed condition scored what the baseline scored;
          a lower score means the agent lost performance as the world changed. It says nothing about
          how well the agent did in absolute terms — an agent can be robust and poor, or excellent
          and fragile.
        </Notice>
      </div>
    </Panel>
  );
}

/**
 * The union of the scenario ids the benchmark engine reported degradations for.
 *
 * A union, not an average: the engine reports the rows it computed, and this
 * lists them in the order the first agent's report presented them so the table
 * reads in benchmark order rather than in whatever order agents finished.
 */
function baselineScenarioIds(report: ComparisonReport): string[] {
  const seen: string[] = [];
  for (const agent of report.agents) {
    for (const row of agent.report?.scenarios ?? []) {
      if (!seen.includes(row.scenarioId)) seen.push(row.scenarioId);
    }
  }
  return seen;
}

/**
 * What went wrong, per agent, split by kind.
 *
 * The split is the point. A case where the objective was not reached is a
 * statement about how an agent performed; a case where the provider faulted is a
 * statement about whether it could execute at all. They are different findings
 * and they are not added together.
 */
function FailurePanel({ report }: { report: ComparisonReport }) {
  const behaviour = report.failures.filter((row) => BEHAVIOUR_FAILURES.has(row.category));
  const execution = report.failures.filter((row) => !BEHAVIOUR_FAILURES.has(row.category));
  return (
    <Panel
      id="failures"
      title="Failure profile"
      description="Each failure class the benchmark engine classified in this experiment's evidence, per agent. Counts are cases flagged, not occurrences: a case with three refused actions counts once."
      source="benchmark"
    >
      <div className="space-y-6">
        <FailureGroup
          title="How the agents performed"
          caption="Behavioural findings: what the agent did with the world it was given."
          rows={behaviour}
          report={report}
        />
        <FailureGroup
          title="Whether the agents could execute"
          caption="Execution findings: faults on the path between the agent and the environment. An agent that could not execute did not necessarily perform poorly, and this table keeps the two apart."
          rows={execution}
          report={report}
        />
      </div>
    </Panel>
  );
}

function FailureGroup({
  title,
  caption,
  rows,
  report,
}: {
  title: string;
  caption: string;
  rows: ComparisonReport['failures'];
  report: ComparisonReport;
}) {
  return (
    <div className="space-y-3">
      <div>
        <p className="font-display text-small uppercase tracking-[0.06em]">{title}</p>
        <p className="mt-1 max-w-prose text-[11px] leading-snug text-muted-foreground">{caption}</p>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Class</TableHead>
              {report.agents.map((agent) => (
                <TableHead key={agent.key} className="text-right">
                  {agent.identity}
                </TableHead>
              ))}
              <TableHead>Finding</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.category}>
                <TableCell>
                  <p className="text-small">{FAILURE_LABELS[row.category] ?? row.category}</p>
                  {row.metric ? (
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                      read from {row.metric}
                    </p>
                  ) : (
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                      classified from the recorded run status
                    </p>
                  )}
                </TableCell>
                {report.agents.map((agent, index) => (
                  <TableCell
                    key={agent.key}
                    className="text-right font-mono text-small tabular-nums"
                  >
                    {row.counts[index] ?? 0}
                  </TableCell>
                ))}
                <TableCell className="text-[11px] leading-snug text-muted-foreground">
                  {failureSummary(row.counts)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/**
 * Each agent's evidence, and a way into it.
 *
 * Every case the agent ran is listed with its recorded status and score, and
 * opens onto the run itself: the details the run recorded, the counterfactual
 * engine's analysis of its decisions, and the trace in the order it happened.
 * An agent that produced no comparable evidence says why, in the reason the
 * failing layer gave — it is never shown as an agent that scored zero.
 */
function AgentsEvidencePanel({ report }: { report: ComparisonReport }) {
  return (
    <Panel
      id="evidence"
      title="Agents and evidence"
      description="What each agent ran, what the environment recorded, and the drills that lead from a score back to the decision that produced it."
      source="trace"
      sourceKind="fact"
    >
      <div className="space-y-8">
        {report.agents.map((agent) => (
          <div key={agent.key} className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-display text-h4">{agent.identity}</p>
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                  {agent.agent.provider} · {agent.agent.model}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip tone={agent.status === 'COMPARED' ? 'ok' : 'warn'}>
                  {agent.status === 'COMPARED' ? 'comparable evidence' : 'no comparable evidence'}
                </StatusChip>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {agent.metrics.evaluatedCaseCount} case(s) evaluated
                </span>
              </div>
            </div>

            {agent.status === 'UNAVAILABLE' ? (
              <Notice>
                <span className="font-medium text-foreground">
                  This agent produced no evidence to compare.{' '}
                </span>
                {agent.unavailableReason
                  ? `${agent.unavailableReason.message} (${agent.unavailableReason.code})`
                  : 'No reason was recorded.'}{' '}
                It is reported as unavailable, not as an agent that scored zero.
              </Notice>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Fact
                label="Overall score"
                value={formatScore(agent.metrics.averageOverallScore)}
                hint="Mean across evaluated cases."
              />
              <Fact
                label="Strongest condition"
                value={agent.strongestScenarioId ? scenarioLabel(agent.strongestScenarioId) : null}
              />
              <Fact
                label="Weakest condition"
                value={agent.weakestScenarioId ? scenarioLabel(agent.weakestScenarioId) : null}
              />
              <Fact
                label="Provider failures"
                value={agent.metrics.providerFailureCount}
                hint="Cases the provider faulted on."
              />
            </div>

            {agent.report && agent.report.runs.length > 0 ? (
              <div className="space-y-2">
                {agent.report.runs.map((run) => (
                  <CaseEvidence
                    key={run.runId}
                    agent={agent.agent}
                    agentLabel={agent.identity}
                    run={run}
                    benchmark={{
                      id: report.experiment.benchmarkId,
                      version: report.experiment.benchmarkVersion,
                      name: report.experiment.benchmarkName,
                    }}
                    objectiveKey={report.experiment.objectiveKey}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                title="No cases recorded"
                description="This agent's benchmark execution created no run, so there is no case evidence to open."
              />
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}
