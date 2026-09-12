// @polsia:user-owned
'use client';

import { LayoutDashboard } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { signOut, useSession } from '@/lib/auth-client';
import { DashboardNav } from './dashboard-nav';

export interface DashboardShellProps {
  children: ReactNode;
}

function hasRole(role: string | null | undefined, expected: string) {
  return (
    role
      ?.split(',')
      .map((item) => item.trim())
      .includes(expected) ?? false
  );
}

export function DashboardShell({ children }: DashboardShellProps) {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const isAdmin = hasRole(session?.user?.role, 'admin');

  useEffect(() => {
    if (!isPending && !session?.user) {
      router.replace('/login');
    }
  }, [isPending, router, session?.user]);

  async function handleSignOut() {
    await signOut();
    router.replace('/login');
  }

  if (isPending) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-gutter">
        <p className="text-sm text-muted-foreground">Loading dashboard...</p>
      </main>
    );
  }

  if (!session?.user) {
    // The effect above redirects to /login; this is the brief transition state,
    // not a stable screen.
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-gutter">
        <p className="text-sm text-muted-foreground">Redirecting to sign in...</p>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="flex min-h-dvh flex-col">
        <header className="border-b border-border/70 bg-background">
          <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-gutter">
            <Link href="/dashboard" className="flex min-w-0 items-center gap-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-card">
                <LayoutDashboard aria-hidden="true" className="size-4" />
              </span>
              <span className="truncate text-sm font-semibold text-foreground">Dashboard</span>
            </Link>
            <Button variant="outline" size="sm" onClick={handleSignOut}>
              Sign out
            </Button>
          </div>
        </header>

        <div className="mx-auto grid w-full max-w-7xl flex-1 gap-6 px-gutter py-6 lg:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="lg:border-r lg:border-border/70 lg:pr-6">
            <DashboardNav />
          </aside>

          <section className="min-w-0">
            <div className="mb-6 flex flex-col gap-1">
              <p className="text-sm text-muted-foreground">Signed in as</p>
              <p className="truncate text-sm font-medium text-foreground">
                {session.user.email ?? session.user.name ?? 'Account'}
              </p>
              <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
                {isAdmin ? 'Admin access' : 'User access'}
              </p>
            </div>
            <Separator className="mb-6" />
            {children}
          </section>
        </div>
      </div>
    </main>
  );
}
