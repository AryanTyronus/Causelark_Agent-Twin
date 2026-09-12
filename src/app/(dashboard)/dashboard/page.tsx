// @polsia:user-owned
'use client';

import { Activity, CreditCard, ShieldCheck, Users } from 'lucide-react';
import { DashboardCard } from '@/components/custom/dashboard/dashboard-card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useSession } from '@/lib/auth-client';

const customerCards = [
  {
    title: 'Account',
    value: 'Active',
    description: 'Your signed-in workspace is ready.',
    icon: ShieldCheck,
  },
  {
    title: 'Plan',
    value: 'Starter',
    description: 'Connect billing modules when needed.',
    icon: CreditCard,
  },
  {
    title: 'Activity',
    value: '0',
    description: 'Use this space for product events.',
    icon: Activity,
  },
  {
    title: 'Support',
    value: 'Open',
    description: 'Add customer support workflows here.',
    icon: Users,
  },
];

const adminCards = [
  {
    title: 'Customers',
    value: '0',
    description: 'Admin-only customer operations go here.',
    icon: Users,
  },
  {
    title: 'Revenue',
    value: '$0',
    description: 'Connect billing modules when needed.',
    icon: CreditCard,
  },
  {
    title: 'Activity',
    value: '0',
    description: 'Use this space for product events.',
    icon: Activity,
  },
  {
    title: 'Access',
    value: 'Admin',
    description: 'Role-aware UI powered by better-auth.',
    icon: ShieldCheck,
  },
];

function hasRole(role: string | null | undefined, expected: string) {
  return (
    role
      ?.split(',')
      .map((item) => item.trim())
      .includes(expected) ?? false
  );
}

export default function DashboardPage() {
  const { data: session } = useSession();
  const isAdmin = hasRole(session?.user?.role, 'admin');
  const summaryCards = isAdmin ? adminCards : customerCards;

  return (
    <div className="grid gap-6">
      <section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground">
            {isAdmin ? 'Admin dashboard' : 'Customer dashboard'}
          </p>
          <h1 className="text-3xl font-semibold tracking-normal text-foreground">Overview</h1>
        </div>
        <Badge variant="secondary" className="w-fit">
          {isAdmin ? 'Admin role' : 'User role'}
        </Badge>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {summaryCards.map((card) => {
          const Icon = card.icon;
          return (
            <DashboardCard
              key={card.title}
              title={card.title}
              description={card.description}
              action={<Icon aria-hidden="true" className="size-4 text-muted-foreground" />}
            >
              <p className="text-2xl font-semibold text-foreground">{card.value}</p>
            </DashboardCard>
          );
        })}
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.8fr)]">
        <DashboardCard
          title="Workspace"
          description={isAdmin ? 'Owner and operations workflows.' : 'Customer-specific workflow.'}
        >
          <div className="grid gap-4">
            {(isAdmin
              ? ['Review users', 'Connect admin metrics', 'Add governed data modules']
              : [
                  'Define the primary metric',
                  'Add the first dashboard widget',
                  'Connect a data module',
                ]
            ).map((item) => (
              <div key={item} className="flex items-center justify-between gap-4">
                <span className="text-sm font-medium text-foreground">{item}</span>
                <Badge variant="outline">Next</Badge>
              </div>
            ))}
          </div>
        </DashboardCard>

        <DashboardCard title="Session" description="Current access state for this shell.">
          <div className="grid gap-3 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Role</span>
              <span className="font-medium text-foreground">
                {isAdmin ? 'admin' : (session?.user?.role ?? 'user')}
              </span>
            </div>
            <Separator />
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Auth module</span>
              <span className="font-medium text-foreground">better-auth</span>
            </div>
            <Separator />
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Route</span>
              <span className="font-medium text-foreground">/dashboard</span>
            </div>
            <Separator />
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Ownership</span>
              <span className="font-medium text-foreground">user-owned</span>
            </div>
          </div>
        </DashboardCard>
      </section>
    </div>
  );
}
