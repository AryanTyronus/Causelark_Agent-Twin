//
// There is no persistent agent registry in this product, and this page does not
// invent one. What it shows is what the *deployment* can actually construct a
// provider client for, read from the provider boundary that execution itself
// uses: which providers are selectable, which are production, which resolve
// here, and which model each one asks for.
//
// No credential is read, returned or displayed. A missing model is shown as a
// missing model, with the variable an operator would set — never as a guess at
// what the deployment probably intended.

'use client';

import { Play } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  ErrorPanel,
  Notice,
  Panel,
  PanelSkeleton,
  StatusChip,
} from '@/components/custom/agent-twin/ui';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { type AgentCatalog, AgentCatalog as AgentCatalogSchema } from '@/lib/contracts/agents';

export default function AgentsPage() {
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const value = await apiFetch('/api/agents', { schema: AgentCatalogSchema });
        if (active) setCatalog(value);
      } catch {
        if (active) setFailed(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (failed)
    return (
      <ErrorPanel
        title="Agent catalogue unavailable"
        message="The provider configuration could not be read. This is a deployment-side problem: no agent can be selected until it is resolved."
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard">Back to the overview</Link>
          </Button>
        }
      />
    );

  return (
    <div className="space-y-6">
      <div>
        <p className="text-eyebrow">Agents</p>
        <h1 className="mt-3 font-display text-h2">What this deployment can run</h1>
        <p className="mt-3 max-w-prose text-small leading-relaxed text-muted-foreground">
          An agent configuration is a provider and the model it asks for. A credential is deployment
          configuration, not part of an agent’s identity — only the model is — so this page lists
          models and never secrets. Any other model the same provider serves can be named when you
          run a test.
        </p>
      </div>

      {catalog === null ? (
        <Panel title="Provider configuration">
          <PanelSkeleton lines={4} label="Loading the provider configuration" />
        </Panel>
      ) : (
        <>
          {catalog.configurationNotice ? (
            <Notice>
              <span className="font-medium text-foreground">
                No agent is configured for this deployment.{' '}
              </span>
              {catalog.configurationNotice} A test can still be started by naming a model, but every
              case will be reported as unavailable rather than scored, because a run that cannot
              reach a provider produces no evidence.
            </Notice>
          ) : null}

          <Panel
            title="Configured agents"
            description="Resolved through the same provider boundary execution uses. These are the configurations this deployment can construct a client for right now."
            source="configuration"
            sourceKind="fact"
            action={
              <Button asChild size="sm">
                <Link href="/dashboard/tests">
                  <Play aria-hidden className="size-3.5" />
                  Run a test
                </Link>
              </Button>
            }
          >
            {catalog.agents.length === 0 ? (
              <p className="text-small text-muted-foreground">
                Nothing resolves here. Configure a provider model and this list will fill in.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] border-collapse text-small">
                  <caption className="sr-only">
                    Agent configurations this deployment resolves
                  </caption>
                  <thead>
                    <tr className="border-b border-border text-left">
                      <Th>Agent</Th>
                      <Th>Version</Th>
                      <Th>Provider</Th>
                      <Th>Model</Th>
                      <Th>Role</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {catalog.agents.map((agent) => (
                      <tr key={agent.key} className="border-b border-border/60">
                        <Td mono>{agent.identity}</Td>
                        <Td mono>{agent.configuration.agentVersion}</Td>
                        <Td mono>{agent.providerLabel}</Td>
                        <Td mono>{agent.configuration.model}</Td>
                        <Td>
                          {agent.isDeploymentDefault ? (
                            <StatusChip tone="info">deployment default</StatusChip>
                          ) : (
                            <span className="text-[11px] text-muted-foreground">selectable</span>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {catalog.defaultAgentKey ? (
              <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                default agent key: {catalog.defaultAgentKey}
              </p>
            ) : null}
          </Panel>

          <Panel
            title="Providers"
            description="The provider boundary this build can speak. A provider that is not configured here cannot be run, and naming it in a test will produce an unavailable result rather than a score."
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] border-collapse text-small">
                <caption className="sr-only">Selectable providers</caption>
                <thead>
                  <tr className="border-b border-border text-left">
                    <Th>Provider</Th>
                    <Th>Class</Th>
                    <Th>Resolves here</Th>
                    <Th>Model</Th>
                  </tr>
                </thead>
                <tbody>
                  {catalog.providers.map((provider) => (
                    <tr key={provider.provider} className="border-b border-border/60">
                      <Td mono>{provider.label}</Td>
                      <Td>
                        <StatusChip tone={provider.production ? 'ok' : 'warn'}>
                          {provider.production ? 'production' : 'development'}
                        </StatusChip>
                      </Td>
                      <Td>
                        <StatusChip tone={provider.configured ? 'ok' : 'idle'}>
                          {provider.configured ? 'configured' : 'not configured'}
                        </StatusChip>
                      </Td>
                      <Td mono>{provider.model ?? 'not set'}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="pb-2 pr-4 text-caption uppercase tracking-[0.06em] text-muted-foreground"
    >
      {children}
    </th>
  );
}

function Td({ children, mono = false }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <td className={`py-2.5 pr-4 align-top ${mono ? 'font-mono text-[11px]' : ''}`}>{children}</td>
  );
}
