// @polsia:user-owned — starter home served at /. Replace it in place, or delete
// this route group before adding another page that resolves to /.

import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  CircleDot,
  Clock3,
  GitBranch,
  Play,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { siteDescription, siteName } from '@/lib/site';

// Keep this a Server Component so it can export metadata.
export const metadata: Metadata = {
  title: { absolute: siteName },
  description: siteDescription,
  // Do not export an explicit openGraph object here; that suppresses the
  // file-based opengraph-image.tsx for the home route.
  alternates: { canonical: '/' },
};

const episodeSteps = [
  { label: 'Observe', value: '02:14.008', icon: ScanSearch, state: 'visible' },
  { label: 'Decide', value: '02:14.081', icon: GitBranch, state: 'policy checked' },
  { label: 'Act', value: '02:14.114', icon: ArrowUpRight, state: 'accepted' },
  { label: 'Resolve', value: '02:14.119', icon: Check, state: 'state advanced' },
];

const methodSteps = [
  {
    number: '01',
    title: 'Give the agent a world',
    text: 'Start every episode from a deterministic seed with resources, rules, hidden state, and a real objective.',
  },
  {
    number: '02',
    title: 'Validate the move',
    text: 'Every proposed action meets the environment’s constraints before it can change the world.',
  },
  {
    number: '03',
    title: 'Advance the state',
    text: 'Observe the response, consume resources, and make the next decision from what the agent can actually know.',
  },
  {
    number: '04',
    title: 'Keep the whole cause chain',
    text: 'Store observations, decisions, transitions, failures, and outcomes as one replayable history.',
  },
];

const metrics = [
  ['Task success', '78.4%', 'objective reached'],
  ['Action success', '92.1%', 'valid actions'],
  ['Invalid actions', '04', 'blocked by rules'],
  ['Resources used', '63%', 'of episode budget'],
  ['Termination', 'GOAL', 'explicit reason'],
];

export default function CauselarkHome() {
  return (
    <main className="overflow-hidden">
      <section className="relative border-b border-border" aria-labelledby="hero-heading">
        <div className="container-page grid min-h-[calc(100vh-3.5rem)] items-center gap-14 py-20 lg:grid-cols-[minmax(0,0.95fr)_minmax(28rem,1.05fr)] lg:gap-20 lg:py-24">
          <div className="relative z-10 max-w-2xl animate-in fade-in slide-in-from-bottom-3 duration-700">
            <div className="mb-8 flex items-center gap-3 text-caption font-semibold uppercase tracking-[0.16em] text-brand-700 dark:text-brand-300">
              <span className="h-px w-10 bg-primary" />
              Agent Twin / autonomous agent testing laboratory
            </div>
            <h1 id="hero-heading" className="max-w-xl font-display text-display text-foreground">
              Test autonomous intelligence before it touches the real world.
            </h1>
            <p className="mt-8 max-w-xl text-body-lg text-muted-foreground">
              Causelark Agent Twin puts autonomous agents inside controlled digital environments,
              stress-tests them under adversarial conditions, and measures how they actually behave.
            </p>
            <div className="mt-10 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              <Button asChild size="lg" className="group rounded-sm px-6">
                <Link href="/dashboard/tests">
                  Run a test
                  <ArrowUpRight className="transition-transform duration-200 ease-out group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </Link>
              </Button>
              <Button asChild variant="ghost" size="lg" className="group rounded-sm">
                <Link href="/dashboard/benchmarks">
                  Explore benchmarks
                  <ArrowDownRight className="transition-transform duration-200 ease-out group-hover:translate-y-0.5" />
                </Link>
              </Button>
            </div>
            <div className="mt-14 flex flex-wrap gap-x-6 gap-y-3 text-caption text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <ShieldCheck className="size-4 text-brand-600 dark:text-brand-300" />
                Constraint-first execution
              </span>
              <span className="inline-flex items-center gap-2">
                <RotateCcw className="size-4 text-brand-600 dark:text-brand-300" />
                Replayable by seed
              </span>
            </div>
          </div>

          <div className="relative animate-in fade-in slide-in-from-right-3 duration-700 lg:translate-y-6">
            <div className="absolute -left-8 -top-8 size-24 border-l border-t border-primary/50" />
            <div className="absolute -bottom-8 -right-8 size-24 border-b border-r border-primary/50" />
            <Card className="relative overflow-hidden rounded-sm border-primary/30 bg-card shadow-2xl">
              <CardHeader className="border-b border-border bg-muted/40 pb-4">
                <div className="flex items-center justify-between gap-4 text-caption uppercase tracking-[0.13em] text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <CircleDot className="size-3.5 text-brand-600 dark:text-brand-300" />
                    Episode 0042
                  </span>
                  <span>Seed 9182 / 12 steps</span>
                </div>
                <CardTitle className="flex items-end justify-between gap-4 pt-4 font-mono text-sm font-medium tracking-normal">
                  <span>resource_routing.world</span>
                  <Badge variant="secondary" className="rounded-sm font-mono text-[10px]">
                    RUNNING
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="grid grid-cols-[1fr_auto] border-b border-border">
                  <div className="p-6 pb-5">
                    <div className="mb-5 flex items-center justify-between text-caption text-muted-foreground">
                      <span>State trajectory</span>
                      <span className="font-mono">t+00:02.119</span>
                    </div>
                    <div className="relative space-y-4 pl-5">
                      <div className="absolute bottom-2 left-[5px] top-2 w-px bg-border" />
                      {episodeSteps.map((step, index) => {
                        const Icon = step.icon;
                        return (
                          <div key={step.label} className="relative flex items-center gap-3">
                            <span
                              className={`absolute -left-5 flex size-3 items-center justify-center rounded-full border-2 border-card ${index === episodeSteps.length - 1 ? 'bg-primary' : 'bg-muted'}`}
                            />
                            <Icon className="size-4 text-brand-700 dark:text-brand-300" />
                            <span className="min-w-16 text-sm font-medium">{step.label}</span>
                            <span className="font-mono text-caption text-muted-foreground">
                              {step.value}
                            </span>
                            <span className="ml-auto hidden text-caption text-muted-foreground sm:block">
                              {step.state}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex w-16 flex-col items-center justify-between border-l border-border bg-muted/20 py-6 text-muted-foreground">
                    <Terminal className="size-4" />
                    <div className="flex h-28 items-end gap-1">
                      {[
                        'h-[34%]',
                        'h-[58%]',
                        'h-[42%]',
                        'h-[76%]',
                        'h-[54%]',
                        'h-[88%]',
                        'h-[68%]',
                      ].map((height, index) => (
                        <span
                          key={height}
                          className={`w-1.5 ${height} ${index === 5 ? 'bg-primary' : 'bg-border'}`}
                        />
                      ))}
                    </div>
                    <span className="font-mono text-[9px] [writing-mode:vertical-rl]">
                      TRACE / LIVE
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-3 divide-x divide-border bg-muted/20">
                  <div className="p-4">
                    <p className="text-caption text-muted-foreground">Actions</p>
                    <p className="mt-1 font-mono text-lg">08 / 12</p>
                  </div>
                  <div className="p-4">
                    <p className="text-caption text-muted-foreground">Invalid</p>
                    <p className="mt-1 font-mono text-lg text-brand-700 dark:text-brand-300">00</p>
                  </div>
                  <div className="p-4">
                    <p className="text-caption text-muted-foreground">Resources</p>
                    <p className="mt-1 font-mono text-lg">63%</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <p className="mt-4 text-right font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Observe → decide → act → resolve
            </p>
            <p className="mt-1 text-right text-[10px] text-muted-foreground">
              Interface illustration — not a recorded result.
            </p>
          </div>
        </div>
      </section>

      <section id="method" className="section-lg scroll-mt-20" aria-labelledby="method-heading">
        <div className="container-page grid gap-14 lg:grid-cols-[0.7fr_1.3fr] lg:gap-24">
          <div>
            <p className="text-eyebrow">The method</p>
            <h2 id="method-heading" className="mt-4 max-w-md font-display text-h2">
              A world that answers back.
            </h2>
            <p className="mt-6 max-w-sm text-body text-muted-foreground">
              Causelark makes the environment a first-class part of the test. The agent does not get
              a free pass from the rules — and your team gets the full reason why.
            </p>
          </div>
          <div className="border-t border-border">
            {methodSteps.map((step) => (
              <div
                key={step.number}
                className="group grid gap-4 border-b border-border py-7 transition-colors duration-200 ease-out hover:bg-muted/40 sm:grid-cols-[4rem_0.8fr_1.2fr] sm:gap-6 sm:px-4"
              >
                <span className="font-mono text-caption text-brand-700 dark:text-brand-300">
                  {step.number}
                </span>
                <h3 className="font-display text-h4">{step.title}</h3>
                <p className="max-w-md text-body text-muted-foreground">{step.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        id="evidence"
        className="scroll-mt-20 border-y border-border bg-muted/40"
        aria-labelledby="evidence-heading"
      >
        <div className="container-page grid gap-12 py-20 lg:grid-cols-[0.8fr_1.2fr] lg:gap-24 lg:py-28">
          <div className="max-w-lg">
            <div className="flex items-center gap-3 text-caption font-semibold uppercase tracking-[0.16em] text-brand-700 dark:text-brand-300">
              <span className="h-px w-10 bg-primary" />
              Evidence, not vibes
            </div>
            <h2 id="evidence-heading" className="mt-6 font-display text-h2">
              Know what changed. Know why.
            </h2>
            <p className="mt-6 text-body-lg text-muted-foreground">
              Measure the outcome and the path that produced it. Compare runs across the same world,
              inspect failure modes, and turn a surprising score into a useful diagnosis.
            </p>
            <div className="mt-8 flex items-center gap-3 text-small text-foreground">
              <Clock3 className="size-4 text-brand-700 dark:text-brand-300" />
              <span>Each transition is time-stamped and attributable.</span>
            </div>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild className="rounded-sm">
                <Link href="/dashboard/tests">
                  Run a test
                  <ArrowUpRight />
                </Link>
              </Button>
              <Button asChild variant="outline" className="rounded-sm">
                <Link href="/dashboard/benchmarks">Explore benchmarks</Link>
              </Button>
            </div>
          </div>
          <Card className="overflow-hidden rounded-sm border-border bg-card shadow-lg">
            <CardHeader className="flex-row items-center justify-between border-b border-border bg-background/60 pb-5">
              <div>
                <p className="font-mono text-caption text-muted-foreground">RUN SUMMARY / 0042</p>
                <CardTitle className="mt-2 font-display text-h4">Resource routing</CardTitle>
              </div>
              <Badge className="rounded-sm bg-primary text-primary-foreground">REPLAYABLE</Badge>
            </CardHeader>
            <CardContent className="p-0">
              {metrics.map(([label, value, detail], index) => (
                <div
                  key={label}
                  className="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-border px-6 py-5 last:border-b-0 sm:grid-cols-[1fr_auto_9rem]"
                >
                  <span className="text-small font-medium">{label}</span>
                  <span
                    className={`font-mono text-lg ${index === 0 ? 'text-brand-700 dark:text-brand-300' : ''}`}
                  >
                    {value}
                  </span>
                  <span className="hidden text-right text-caption text-muted-foreground sm:block">
                    {detail}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </section>

      <section id="replay" className="section-lg scroll-mt-20" aria-labelledby="replay-heading">
        <div className="container-page">
          <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-end">
            <div className="max-w-2xl">
              <p className="text-eyebrow">Replay the cause</p>
              <h2 id="replay-heading" className="mt-4 font-display text-h2">
                Replay the cause, not just the score.
              </h2>
            </div>
            <p className="max-w-xs text-small text-muted-foreground lg:text-right">
              Deterministic seeds turn “it failed once” into a run your whole team can open,
              discuss, and fix.
            </p>
          </div>

          <div className="mt-14 overflow-hidden border-y border-border">
            <div className="grid min-w-[42rem] grid-cols-5 divide-x divide-border">
              {['Initial state', 'Observation', 'Decision', 'Constraint', 'Outcome'].map(
                (label, index) => (
                  <div key={label} className="relative p-5 sm:p-7">
                    <div className="mb-10 flex items-center justify-between">
                      <span className="font-mono text-caption text-muted-foreground">
                        0{index + 1}
                      </span>
                      {index === 2 && <Play className="size-4 fill-primary text-primary" />}
                    </div>
                    <div className="mb-5 flex items-center gap-2">
                      <span
                        className={`size-3 rounded-full border-2 ${index === 2 ? 'border-primary bg-primary' : 'border-brand-600 dark:border-brand-300'}`}
                      />
                      <span className="h-px flex-1 bg-border" />
                    </div>
                    <p className="font-display text-h4">{label}</p>
                    <p className="mt-3 text-caption text-muted-foreground">
                      {index === 0 && 'seed: 9182'}
                      {index === 1 && 'inventory is partial'}
                      {index === 2 && 'route: supply_b'}
                      {index === 3 && 'capacity check passed'}
                      {index === 4 && 'objective reached'}
                    </p>
                  </div>
                ),
              )}
            </div>
          </div>
        </div>
      </section>

      <section
        id="contact"
        className="scroll-mt-20 pb-24 sm:pb-32"
        aria-labelledby="contact-heading"
      >
        <div className="container-page">
          <Card className="relative overflow-hidden rounded-sm border-primary/40 bg-primary text-primary-foreground shadow-xl">
            <div className="absolute right-0 top-0 size-48 translate-x-1/3 -translate-y-1/3 rounded-full border border-primary-foreground/20" />
            <div className="absolute bottom-0 right-24 size-32 translate-y-1/2 rounded-full border border-primary-foreground/10" />
            <CardContent className="relative grid gap-10 p-8 sm:p-12 lg:grid-cols-[1fr_auto] lg:items-end lg:p-16">
              <div className="max-w-2xl">
                <p className="font-mono text-caption uppercase tracking-[0.16em] text-primary-foreground/70">
                  Build with evidence
                </p>
                <h2
                  id="contact-heading"
                  className="mt-4 font-display text-h2 text-primary-foreground"
                >
                  Make your next agent run explainable.
                </h2>
                <p className="mt-5 max-w-xl text-body-lg text-primary-foreground/80">
                  Put an agent inside the simulator, stress it under conditions it did not choose,
                  and read the evidence before it meets a real one.
                </p>
              </div>
              <div className="flex flex-col items-start gap-4 lg:items-end">
                <Button asChild size="lg" variant="secondary" className="group rounded-sm px-6">
                  <Link href="/dashboard/tests">
                    Run a test
                    <ArrowUpRight className="transition-transform duration-200 ease-out group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                  </Link>
                </Button>
                <a
                  href="mailto:causelark-6@polsia.app?subject=Causelark%20access"
                  className="font-mono text-caption text-primary-foreground/75 transition-colors duration-200 hover:text-primary-foreground"
                >
                  causelark-6@polsia.app
                </a>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>
    </main>
  );
}
