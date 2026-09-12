// @polsia:user-owned — seeded by polsia/modules/better-auth; restyle freely.

import { SignUpForm } from '@/components/custom/sign-up-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function SignupPage() {
  return (
    <main className="min-h-dvh flex items-center justify-center px-gutter py-section bg-[var(--background)]">
      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <div className="absolute top-[-30%] left-1/2 -translate-x-1/2 w-[800px] h-[800px] rounded-full bg-[var(--brand-100)] opacity-40 blur-3xl" />
        <div className="absolute bottom-[-20%] left-[-10%] w-[500px] h-[500px] rounded-full bg-[var(--brand-200)] opacity-30 blur-3xl" />
      </div>

      <Card className="relative w-full max-w-md shadow-brand border border-border/60 bg-card/95 backdrop-blur-sm">
        <CardHeader className="text-center pb-2">
          <CardTitle className="text-h4">Create an account</CardTitle>
          <CardDescription>Get started — it&apos;s free</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <SignUpForm />
          <p className="mt-4 text-center text-small text-muted-foreground">
            Already have an account?{' '}
            <a
              href="/login"
              className="text-brand-600 font-medium hover:text-brand-700 hover:underline underline-offset-2 transition-colors"
            >
              Sign in
            </a>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
