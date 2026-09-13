//
// Five destinations, in the order the work is actually done: hand an objective to
// the operator, run a test by hand, read the standardised tests, see which agents
// this deployment can run, read the reference. The operator sits first because it
// is the front door for the question this product exists to answer — "is this
// agent ready?" — and because everything else here is what it reaches for. The
// recorded runs are not a destination of their own: they are reached from a
// result or from the overview, because a run is evidence for a test rather than
// a place you go on your own.

'use client';

import { BookOpen, Compass, Cpu, FlaskConical, LayoutDashboard, Ruler } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const navItems = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/operator', label: 'Operator', icon: Compass },
  { href: '/dashboard/tests', label: 'Tests', icon: FlaskConical },
  { href: '/dashboard/benchmarks', label: 'Benchmarks', icon: Ruler },
  { href: '/dashboard/agents', label: 'Agents', icon: Cpu },
  { href: '/dashboard/docs', label: 'Documentation', icon: BookOpen },
];

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Agent Twin"
      className="flex gap-2 overflow-x-auto pb-1 lg:grid lg:overflow-visible lg:pb-0"
    >
      {navItems.map((item) => {
        const Icon = item.icon;
        const active =
          item.href === '/dashboard'
            ? pathname === '/dashboard'
            : pathname === item.href || pathname.startsWith(`${item.href}/`);

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex h-10 shrink-0 items-center gap-2 rounded-sm px-3 text-small transition-colors',
              active
                ? 'bg-secondary font-medium text-secondary-foreground'
                : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground',
            )}
          >
            <Icon aria-hidden="true" className="size-4" />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
