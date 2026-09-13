'use client';

import { BatteryCharging, Droplets, Package, ShieldAlert, WalletCards } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import type { SimulationRunDetail, SimulationState } from '@/lib/contracts/simulation';

const resources = [
  { key: 'energy' as const, label: 'Energy', icon: BatteryCharging },
  { key: 'materials' as const, label: 'Materials', icon: Package },
  { key: 'water' as const, label: 'Water', icon: Droplets },
];

export function SimulationStatePanel({
  run,
  state,
}: {
  run: SimulationRunDetail;
  state: SimulationState;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
      <Card className="border-brand-200/70 shadow-md dark:border-brand-900/50">
        <CardHeader className="pb-3">
          <CardTitle className="font-display text-h4">Observable world</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            {resources.map(({ key, label, icon: Icon }) => (
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
              value={Math.min(100, (state.progress / state.target) * 100)}
              aria-label={`Objective progress: ${state.progress} of ${state.target}`}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="Step" value={`${state.step} / ${state.maxSteps}`} />
            <Metric
              label="Budget"
              value={`${state.budgetRemaining} left`}
              icon={<WalletCards className="size-4" />}
            />
            <Metric
              label="Risk"
              value={`${state.risk} / ${state.maxRisk}`}
              icon={<ShieldAlert className="size-4" />}
            />
          </div>
        </CardContent>
      </Card>
      <Card className="shadow-md">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="font-display text-h4">Tasks & guardrails</CardTitle>
            <Badge
              variant={
                run.status === 'RUNNING'
                  ? 'secondary'
                  : run.status === 'COMPLETED'
                    ? 'default'
                    : 'destructive'
              }
            >
              {run.agentStatus}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {state.tasks.map((task) => (
            <div key={task.id} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{task.title}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {task.progress} / {task.requiredAmount}
                </span>
              </div>
              <Progress
                className="mt-2 h-2"
                value={Math.min(100, (task.progress / task.requiredAmount) * 100)}
                aria-label={`${task.title} progress`}
              />
            </div>
          ))}
          <div className="space-y-2">
            <p className="text-eyebrow">Constraints</p>
            {state.constraints.map((constraint) => (
              <p key={constraint} className="text-xs leading-relaxed text-muted-foreground">
                {constraint}
              </p>
            ))}
          </div>
          {run.failureDetails && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {run.failureDetails}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 flex items-center gap-1 font-mono text-sm">
        {icon}
        {value}
      </p>
    </div>
  );
}
