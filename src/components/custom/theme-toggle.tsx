// @polsia:user-owned — light/dark theme toggle. Reusable; mounted in SiteNav.

'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      {/* Visibility is driven by the `.dark` class (set by next-themes outside React),
          not React state — so server and client markup match and there's no flash. */}
      <Sun className="block dark:hidden" />
      <Moon className="hidden dark:block" />
    </Button>
  );
}
