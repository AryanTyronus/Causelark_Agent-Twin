// @polsia:user-owned — seeded by polsia/modules/better-auth; restyle freely.
'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { signOut, useSession } from '@/lib/auth-client';

export function AuthNav() {
  const { data: session, isPending } = useSession();

  // Render nothing until the session resolves — avoids a Sign-in→Profile flash.
  if (isPending) return null;

  if (!session?.user) {
    return (
      <nav className="flex items-center gap-2">
        <Button asChild variant="ghost">
          <Link href="/login">Sign in</Link>
        </Button>
        <Button asChild>
          <Link href="/signup">Sign up</Link>
        </Button>
      </nav>
    );
  }

  return (
    <nav className="flex items-center gap-2">
      <Button asChild variant="ghost">
        <Link href="/profile">Profile</Link>
      </Button>
      <Button
        type="button"
        variant="secondary"
        onClick={async () => {
          await signOut();
          window.location.assign('/');
        }}
      >
        Sign out
      </Button>
    </nav>
  );
}
