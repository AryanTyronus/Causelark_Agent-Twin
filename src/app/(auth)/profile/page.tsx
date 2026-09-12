// @polsia:user-owned — seeded by polsia/modules/better-auth; restyle freely.
'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { signOut, useSession } from '@/lib/auth-client';

export default function ProfilePage() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <main className="min-h-dvh flex items-center justify-center px-gutter bg-[var(--background)]">
        <p className="text-muted-foreground">Loading…</p>
      </main>
    );
  }

  if (!session?.user) {
    return (
      <main className="min-h-dvh flex items-center justify-center px-gutter py-section bg-[var(--background)]">
        <Card className="w-full max-w-md shadow-brand border border-border/60 bg-card/95 backdrop-blur-sm">
          <CardHeader className="text-center pb-2">
            <CardTitle className="text-h4">Not signed in</CardTitle>
            <CardDescription>Sign in to view your profile</CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            <Button asChild className="w-full">
              <a href="/login">Sign in</a>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-dvh px-gutter py-section bg-[var(--background)]">
      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <div className="absolute top-[-20%] right-[-5%] w-[600px] h-[600px] rounded-full bg-[var(--brand-100)] opacity-30 blur-3xl" />
        <div className="absolute bottom-[-10%] left-[-10%] w-[400px] h-[400px] rounded-full bg-[var(--brand-200)] opacity-20 blur-3xl" />
      </div>

      <div className="relative max-w-lg mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-16 h-16 rounded-full bg-[var(--brand-200)] flex items-center justify-center text-h3 font-bold text-brand-700 select-none">
            {session.user.name?.charAt(0).toUpperCase() ?? '?'}
          </div>
          <div>
            <h1 className="text-h3 font-bold text-foreground">{session.user.name}</h1>
            <p className="text-muted-foreground text-body">{session.user.email}</p>
          </div>
        </div>

        <Separator className="my-6" />

        <Card className="shadow-brand border border-border/60 bg-card/95 backdrop-blur-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-h4">Account details</CardTitle>
            <CardDescription>Your profile information</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="flex justify-between items-center py-2">
              <span className="text-muted-foreground text-body">Name</span>
              <span className="font-medium text-foreground">{session.user.name}</span>
            </div>
            <Separator />
            <div className="flex justify-between items-center py-2">
              <span className="text-muted-foreground text-body">Email</span>
              <span className="font-medium text-foreground">{session.user.email}</span>
            </div>
          </CardContent>
        </Card>

        <div className="mt-6 flex justify-end">
          <Button
            variant="secondary"
            onClick={async () => {
              await signOut();
              window.location.assign('/login');
            }}
          >
            Sign out
          </Button>
        </div>
      </div>
    </main>
  );
}
