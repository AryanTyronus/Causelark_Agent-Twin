// @polsia:user-owned

import type { HTMLAttributes, ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface DashboardCardProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}

export function DashboardCard({
  title,
  description,
  action,
  children,
  className,
  ...props
}: DashboardCardProps) {
  return (
    <Card className={cn('border-border/70 shadow-sm', className)} {...props}>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0 pb-3">
        <div className="grid gap-1">
          <CardTitle className="text-base font-semibold">{title}</CardTitle>
          {description ? (
            <CardDescription className="text-sm">{description}</CardDescription>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
