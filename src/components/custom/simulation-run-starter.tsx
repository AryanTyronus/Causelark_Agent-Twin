// @polsia:user-owned — interactive deterministic simulation workspace.
'use client';

import {
  Activity,
  BatteryCharging,
  Droplets,
  FlaskConical,
  Package,
  Play,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  StepForward,
  Target,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiFetch } from '@/lib/api-client';
import {
  SimulationActionInput,
  type SimulationActionInput as SimulationActionInputType,
  type SimulationActionRecord,
  SimulationActionResult,
  SimulationAgentStepResult,
  type SimulationOptions,
  SimulationOptions as SimulationOptionsSchema,
  type SimulationRunDetail,
  SimulationRunDetail as SimulationRunDetailSchema,
  SimulationRunList as SimulationRunListSchema,
  type SimulationRunSummary,
  SimulationRunSummary as SimulationRunSummarySchema,
  SimulationStartInput,
  SimulationState,
  type SimulationState as SimulationStateType,
} from '@/lib/contracts/simulation';

const RESOURCE_OPTIONS = [
  { key: 'energy' as const, label: 'Energy', icon: BatteryCharging },
  { key: 'materials' as const, label: 'Materials', icon: Package },
  { key: 'water' as const, label: 'Water', icon: Droplets },
];

function summaryFromRun(run: SimulationRunDetail): SimulationRunSummary {
  return {
    id: run.id,
    environmentKey: run.environmentKey,
    objectiveKey: run.objectiveKey,
    seed: run.seed,
    status: run.status,
    agentStatus: run.agentStatus,
    step: run.step,
    maxSteps: run.maxSteps,
    budgetRemaining: run.budgetRemaining,
    terminationReason: run.terminationReason,
    failureDetails: run.failureDetails,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function statusVariant(status: SimulationRunDetail['status']) {
  if (status === 'FAILED' || status === 'ERROR' || status === 'TIMEOUT')
    return 'destructive' as const;
  if (status === 'COMPLETED') return 'default' as const;
  return 'secondary' as const;
}

function formatAction(action: SimulationActionRecord): string {
  const resource = action.input.resource ? ` ${action.input.resource}` : '';
  return `${action.input.type}${resource} × ${action.input.amount}`;
}

function updateRunList(
  runs: SimulationRunSummary[],
  nextRun: SimulationRunDetail,
): SimulationRunSummary[] {
  return [summaryFromRun(nextRun), ...runs.filter((run) => run.id !== nextRun.id)].slice(0, 20);
}

export function SimulationRunStarter() {
  const [options, setOptions] = useState<SimulationOptions | null>(null);
  const [runs, setRuns] = useState<SimulationRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [run, setRun] = useState<SimulationRunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRunLoading, setIsRunLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [environmentKey, setEnvironmentKey] = useState('');
  const [objectiveKey, setObjectiveKey] = useState('');
  const [seed, setSeed] = useState('');
  const [startError, setStartError] = useState<string | null>(null);
  const [actionType, setActionType] = useState<SimulationActionInputType['type']>('harvest');
  const [actionResource, setActionResource] =
    useState<SimulationActionInputType['resource']>('materials');
  const [actionAmount, setActionAmount] = useState('1');
  const [actionError, setActionError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isActing, setIsActing] = useState(false);
  const [isAdvancing, setIsAdvancing] = useState(false);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    Promise.all([
      apiFetch('/api/simulations/options', { schema: SimulationOptionsSchema }),
      apiFetch('/api/simulations/runs', { schema: SimulationRunListSchema }),
    ])
      .then(([nextOptions, nextRuns]) => {
        if (!active) return;
        setOptions(nextOptions);
        setRuns(nextRuns.runs.map((item) => SimulationRunSummarySchema.parse(item)));
        setEnvironmentKey(nextOptions.environments[0]?.key ?? '');
        setObjectiveKey(nextOptions.objectives[0]?.key ?? '');
        setSeed(String(nextOptions.seeds[0]?.value ?? ''));
        setSelectedRunId(nextRuns.runs[0]?.id ?? null);
      })
      .catch(() => {
        if (active) setLoadError('The simulation catalogue could not be loaded.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedRunId) {
      setRun(null);
      return;
    }

    let active = true;
    setIsRunLoading(true);
    apiFetch(`/api/simulations/runs/${selectedRunId}`, { schema: SimulationRunDetailSchema })
      .then((nextRun) => {
        if (active) setRun(SimulationRunDetailSchema.parse(nextRun));
      })
      .catch(() => {
        if (active) toast.error('That simulation run could not be loaded.');
      })
      .finally(() => {
        if (active) setIsRunLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selectedRunId]);

  const selectedObjective = useMemo(
    () => options?.objectives.find((item) => item.key === objectiveKey),
    [objectiveKey, options],
  );
  const selectedAction = useMemo(
    () => options?.actions.find((item) => item.key === actionType),
    [actionType, options],
  );

  async function startRun() {
    setStartError(null);
    const input = {
      environmentKey,
      objectiveKey,
      seed: Number(seed),
    };
    const parsed = SimulationStartInput.safeParse(input);
    if (!parsed.success) {
      setStartError(
        parsed.error.flatten().fieldErrors.seed?.[0] ??
          'Choose a valid environment, objective, and replay seed.',
      );
      return;
    }

    setIsStarting(true);
    try {
      const nextRun = SimulationRunDetailSchema.parse(
        await apiFetch('/api/simulations/runs', {
          method: 'POST',
          body: JSON.stringify(input),
          schema: SimulationRunDetailSchema,
        }),
      );
      setRun(nextRun);
      setRuns((current) => updateRunList(current, nextRun));
      setSelectedRunId(nextRun.id);
      toast.success('Persistent Agent Twin run started.');
    } catch (error) {
      const cause = error instanceof Error ? error.cause : null;
      const message =
        cause && typeof cause === 'object' && 'errors' in cause
          ? Object.values((cause as { errors: Record<string, string> }).errors)[0]
          : null;
      setStartError(message ?? 'The run could not be started.');
      toast.error('The run could not be started.');
    } finally {
      setIsStarting(false);
    }
  }

  async function advanceAgent() {
    if (!run || run.status !== 'RUNNING') return;
    setIsAdvancing(true);
    try {
      const result = await apiFetch(`/api/simulations/runs/${run.id}/agent-step`, {
        method: 'POST',
        body: '{}',
        schema: SimulationAgentStepResult,
      });
      const nextRun = SimulationRunDetailSchema.parse(result.run);
      setRun(nextRun);
      setRuns((current) => updateRunList(current, nextRun));
      toast(
        result.turn.safeError ??
          `Agent turn recorded ${result.turn.acceptedActions} validated action(s).`,
      );
    } catch {
      toast.error('The agent turn failed; refresh to inspect the persisted recovery state.');
    } finally {
      setIsAdvancing(false);
    }
  }

  async function submitAction() {
    if (!run || run.status !== 'RUNNING') return;
    setActionError(null);
    const input = {
      type: actionType,
      amount: Number(actionAmount),
      ...(actionType === 'rest' ? {} : { resource: actionResource }),
    };
    const parsed = SimulationActionInput.safeParse(input);
    if (!parsed.success) {
      setActionError(parsed.error.flatten().fieldErrors.amount?.[0] ?? 'Choose a valid action.');
      return;
    }

    setIsActing(true);
    try {
      const result = await apiFetch(`/api/simulations/runs/${run.id}/actions`, {
        method: 'POST',
        body: JSON.stringify(parsed.data),
        schema: SimulationActionResult,
      });
      const nextRun = SimulationRunDetailSchema.parse(result.run);
      setRun(nextRun);
      setRuns((current) => updateRunList(current, nextRun));
      toast.success(result.action.observation);
    } catch (error) {
      const cause = error instanceof Error ? error.cause : null;
      const rejected = SimulationActionResult.safeParse(cause);
      if (rejected.success) {
        setRun(rejected.data.run);
        setRuns((current) => updateRunList(current, rejected.data.run));
        setActionError(rejected.data.action.rejectionReason ?? 'Action rejected.');
        toast.error(rejected.data.action.rejectionReason ?? 'Action rejected.');
      } else {
        setActionError('The action could not be recorded.');
        toast.error('The action could not be recorded.');
      }
    } finally {
      setIsActing(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-96 items-center justify-center text-sm text-muted-foreground">
        Loading simulation lab…
      </div>
    );
  }

  if (loadError || !options) {
    return (
      <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
        {loadError ?? 'Simulation lab unavailable.'}
      </p>
    );
  }

  const state: SimulationStateType | null = run ? SimulationState.parse(run.state) : null;
  const progressValue = state ? Math.min(100, (state.progress / state.target) * 100) : 0;

  return (
    <div className="space-y-8 pb-12">
      <section className="relative overflow-hidden rounded-xl border border-brand-200/70 bg-gradient-to-br from-brand-50 via-card to-background p-6 shadow-lg dark:border-brand-900/50 dark:from-brand-950/50 sm:p-8">
        <div className="absolute -right-10 -top-16 size-48 rounded-full bg-brand-400/10 blur-3xl" />
        <div className="relative max-w-3xl">
          <div className="flex items-center gap-2 text-eyebrow">
            <FlaskConical className="size-4" />
            Causelark / operator workspace
          </div>
          <h1 className="mt-3 font-display text-h1">{options.title}</h1>
          <p className="mt-3 max-w-2xl text-body text-muted-foreground">{options.description}</p>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
        <Card className="overflow-hidden border-brand-200/70 shadow-md dark:border-brand-900/50">
          <CardHeader className="border-b border-border bg-muted/30">
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="font-display text-h4">Start a new episode</CardTitle>
                <CardDescription className="mt-2">
                  Same inputs, same world, same replay.
                </CardDescription>
              </div>
              <div className="rounded-md bg-primary/10 p-2 text-primary">
                <Play className="size-4" />
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5 p-6">
            <div className="space-y-2">
              <Label htmlFor="simulation-environment">Environment</Label>
              <Select value={environmentKey} onValueChange={setEnvironmentKey}>
                <SelectTrigger id="simulation-environment">
                  <SelectValue placeholder="Choose an environment" />
                </SelectTrigger>
                <SelectContent>
                  {options.environments.map((item) => (
                    <SelectItem key={item.key} value={item.key}>
                      {item.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {options.environments.find((item) => item.key === environmentKey)?.description}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="simulation-objective">Objective</Label>
              <Select value={objectiveKey} onValueChange={setObjectiveKey}>
                <SelectTrigger id="simulation-objective">
                  <SelectValue placeholder="Choose an objective" />
                </SelectTrigger>
                <SelectContent>
                  {options.objectives.map((item) => (
                    <SelectItem key={item.key} value={item.key}>
                      {item.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{selectedObjective?.description}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="simulation-seed">Replay seed</Label>
              <Select value={seed} onValueChange={setSeed}>
                <SelectTrigger id="simulation-seed">
                  <SelectValue placeholder="Choose a seed" />
                </SelectTrigger>
                <SelectContent>
                  {options.seeds.map((item) => (
                    <SelectItem key={String(item.value)} value={String(item.value)}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {startError && (
              <p className="text-sm text-destructive" role="alert">
                {startError}
              </p>
            )}
            <Button type="button" className="w-full" onClick={startRun} disabled={isStarting}>
              <Play className="size-4" />
              {isStarting ? 'Starting episode…' : 'Start deterministic run'}
            </Button>
          </CardContent>
        </Card>

        <Card className="min-h-[32rem] border-border shadow-md">
          <CardHeader className="border-b border-border bg-muted/20">
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle className="font-display text-h4">Run trace</CardTitle>
                <CardDescription className="mt-2">
                  Select a persisted run to inspect its current observation.
                </CardDescription>
              </div>
              <Activity className="size-5 text-brand-600" />
            </div>
          </CardHeader>
          <CardContent className="space-y-6 p-6">
            {runs.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-muted/20 p-8 text-center">
                <Target className="mx-auto size-8 text-brand-600" />
                <p className="mt-3 font-medium">No runs yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Start an episode to build a replayable trace.
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {runs.map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    variant={item.id === selectedRunId ? 'secondary' : 'outline'}
                    size="sm"
                    onClick={() => setSelectedRunId(item.id)}
                  >
                    Seed {item.seed}
                    <Badge variant={statusVariant(item.status)}>{item.status}</Badge>
                  </Button>
                ))}
              </div>
            )}

            {isRunLoading ? (
              <p className="py-12 text-center text-sm text-muted-foreground">Loading run trace…</p>
            ) : run && state ? (
              <div className="space-y-6">
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
                  <div>
                    <p className="text-eyebrow">
                      {options.environments.find((item) => item.key === run.environmentKey)?.title}
                    </p>
                    <h2 className="mt-1 font-display text-h3">
                      {options.objectives.find((item) => item.key === run.objectiveKey)?.title}
                    </h2>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      seed:{run.seed} / run:{run.id.slice(0, 8)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={statusVariant(run.status)} className="px-3 py-1">
                      {run.status}
                    </Badge>
                    <Badge variant="outline">{run.agentStatus}</Badge>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand-200/70 bg-brand-50/40 p-4 dark:border-brand-900/50 dark:bg-brand-950/20">
                  <div>
                    <p className="font-medium">Autonomous Agent Twin</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      One request-driven Strands turn; every tool call and validation is persisted.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      onClick={advanceAgent}
                      disabled={isAdvancing || run.status !== 'RUNNING'}
                    >
                      <Sparkles className="size-4" />
                      {isAdvancing ? 'Running turn…' : 'Run agent turn'}
                    </Button>
                    <Button asChild type="button" variant="outline">
                      <Link href={`/dashboard/simulations/${run.id}`}>Inspect full trace</Link>
                    </Button>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  {RESOURCE_OPTIONS.map(({ key, label, icon: Icon }) => (
                    <div key={key} className="rounded-lg border border-border bg-muted/20 p-4">
                      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <Icon className="size-4 text-brand-600" />
                        {label}
                      </div>
                      <p className="mt-2 font-mono text-2xl">
                        {state.resources[key]}
                        <span className="text-sm text-muted-foreground"> / {state.capacity}</span>
                      </p>
                    </div>
                  ))}
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>Objective progress</span>
                    <span className="font-mono">
                      {state.progress} / {state.target}
                    </span>
                  </div>
                  <Progress
                    value={progressValue}
                    aria-label={`Objective progress: ${state.progress} of ${state.target}`}
                    className="h-3"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>
                      Step {state.step} / {state.maxSteps}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <ShieldAlert className="size-3" /> Risk {state.risk} / {state.maxRisk}
                    </span>
                  </div>
                </div>

                {run.terminationReason && (
                  <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
                    {run.terminationReason}
                  </p>
                )}

                <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                  <div className="space-y-3 rounded-lg border border-brand-200/70 bg-brand-50/40 p-4 dark:border-brand-900/50 dark:bg-brand-950/20">
                    <div className="flex items-center gap-2">
                      <StepForward className="size-4 text-brand-600" />
                      <h3 className="font-medium">Submit an action</h3>
                    </div>
                    <p className="text-xs text-muted-foreground">{selectedAction?.description}</p>
                    <div className="space-y-2">
                      <Label htmlFor="simulation-action">Action</Label>
                      <Select
                        value={actionType}
                        onValueChange={(value) =>
                          setActionType(value as SimulationActionInputType['type'])
                        }
                        disabled={run.status !== 'RUNNING'}
                      >
                        <SelectTrigger id="simulation-action">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {options.actions.map((item) => (
                            <SelectItem key={item.key} value={item.key}>
                              {item.title}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {actionType !== 'rest' && (
                      <div className="space-y-2">
                        <Label htmlFor="simulation-resource">Resource</Label>
                        <Select
                          value={actionResource}
                          onValueChange={(value) =>
                            setActionResource(value as SimulationActionInputType['resource'])
                          }
                          disabled={run.status !== 'RUNNING'}
                        >
                          <SelectTrigger id="simulation-resource">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {RESOURCE_OPTIONS.map((item) => (
                              <SelectItem key={item.key} value={item.key}>
                                {item.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label htmlFor="simulation-amount">Amount</Label>
                      <Input
                        id="simulation-amount"
                        type="number"
                        min={1}
                        max={5}
                        value={actionAmount}
                        onChange={(event) => setActionAmount(event.target.value)}
                        disabled={run.status !== 'RUNNING'}
                      />
                    </div>
                    {actionError && (
                      <p className="text-sm text-destructive" role="alert">
                        {actionError}
                      </p>
                    )}
                    <Button
                      type="button"
                      className="w-full"
                      onClick={submitAction}
                      disabled={isActing || run.status !== 'RUNNING'}
                    >
                      <Zap className="size-4" />
                      {isActing ? 'Recording…' : 'Record action'}
                    </Button>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="font-medium">Action history</h3>
                      <span className="font-mono text-xs text-muted-foreground">
                        {run.actions.length} recorded · {state.budgetRemaining} budget left
                      </span>
                    </div>
                    {run.actions.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
                        No actions yet. The initial observation is ready.
                      </p>
                    ) : (
                      <ol className="max-h-80 space-y-2 overflow-y-auto pr-1">
                        {run.actions.map((action) => (
                          <li
                            key={action.id}
                            className="rounded-md border border-border bg-card p-3"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <span className="font-mono text-xs text-muted-foreground">
                                T+{action.step} · {formatAction(action)}
                              </span>
                              <Badge variant={action.accepted ? 'default' : 'destructive'}>
                                {action.accepted ? 'accepted' : 'rejected'}
                              </Badge>
                            </div>
                            <p className="mt-2 text-sm">
                              {action.accepted ? action.observation : action.rejectionReason}
                            </p>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex min-h-64 flex-col items-center justify-center text-center text-muted-foreground">
                <RotateCcw className="size-7 text-brand-600" />
                <p className="mt-3 text-sm">Choose a run to resume its trace.</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
