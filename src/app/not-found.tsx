// @polsia:user-owned — app 404 page.

import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="container mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <h1 className="font-display text-4xl font-semibold tracking-tight">404</h1>
      <p className="text-muted-foreground">This page does not exist.</p>
      <Link href="/" className="text-sm font-medium text-brand-500 underline">
        Back to home
      </Link>
    </main>
  );
}
