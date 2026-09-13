//
// A header that says what the product is, a nav for the five destinations, and
// the signed-in operator named once. Everything else is the page's. The
// authentication behaviour is unchanged from the template: the session is read
// on the client, an absent session is redirected to /login, and the route
// handlers behind these pages enforce ownership again on the server.

'use client';

import { Play } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { signOut, useSession } from '@/lib/auth-client';
import { DashboardNav } from './dashboard-nav';

export interface DashboardShellProps {
  children: ReactNode;
}

export function DashboardShell({ children }: DashboardShellProps) {
  const { data: session, isPending } = useSession();
  const router = useRouter();

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
        <p className="text-small text-muted-foreground">Opening the console…</p>
      </main>
    );
  }

  if (!session?.user) {
    // The effect above redirects to /login; this is the brief transition state,
    // not a stable screen.
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-gutter">
        <p className="text-small text-muted-foreground">Redirecting to sign in…</p>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="flex min-h-dvh flex-col">
        <header className="border-b border-border bg-background">
          <div className="mx-auto flex h-14 w-full max-w-[var(--container-page)] items-center justify-between gap-4 px-gutter">
            <Link href="/dashboard" className="flex min-w-0 items-baseline gap-2">
              <span className="font-display text-small font-medium tracking-[0.02em]">
                Causelark
              </span>
              <span className="text-caption text-muted-foreground">/ Agent Twin</span>
            </Link>
            <div className="flex items-center gap-3">
              <Button asChild size="sm">
                <Link href="/dashboard/tests">
                  <Play aria-hidden="true" className="size-3.5" />
                  Run a test
                </Link>
              </Button>
              <Button variant="ghost" size="sm" onClick={handleSignOut}>
                Sign out
              </Button>
            </div>
          </div>
        </header>

        <div className="mx-auto grid w-full max-w-[var(--container-page)] flex-1 gap-8 px-gutter py-6 lg:grid-cols-[200px_minmax(0,1fr)]">
          {/*
            `min-w-0` lets this column shrink to the viewport. Without it the
            column's minimum is the navigation's full width, so on a narrow
            screen the nav pushes the whole page wider than the screen instead of
            scrolling inside its own strip.
          */}
          <aside className="min-w-0 lg:border-r lg:border-border lg:pr-6">
            <DashboardNav />
            <div className="mt-6 hidden border-t border-border pt-4 lg:block">
              {/*
                "Signed in", not "Operator": the operator is now a destination in
                the nav above, and two different things on one screen sharing a
                label is a screen a reader has to decode.
              */}
              <p className="text-caption uppercase tracking-[0.06em] text-muted-foreground">
                Signed in
              </p>
              <p className="mt-1 truncate text-small" title={session.user.email ?? undefined}>
                {session.user.email ?? session.user.name ?? 'Account'}
              </p>
            </div>
          </aside>

          <section className="min-w-0">{children}</section>
        </div>
      </div>
    </main>
  );
}
