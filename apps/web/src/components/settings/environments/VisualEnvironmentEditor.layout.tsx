'use client';

import type { ReactNode } from 'react';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleIconTrigger,
  CollapsibleTrigger,
} from '@/components/system';
import { cn } from '@/lib/utils';

type SectionIcon = Parameters<typeof CollapsibleIconTrigger>[0]['icon'];

export function FieldShell({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn('space-y-2', className)}>{children}</div>;
}

export function SectionShell({
  icon: Icon,
  title,
  action,
  children,
  className,
  defaultOpen = true,
}: {
  icon: SectionIcon;
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  return (
    <Collapsible
      asChild
      defaultOpen={defaultOpen}
      className={cn('group rounded-md bg-card p-4', className)}
    >
      <section>
        <div className="flex items-center justify-between gap-3">
          <CollapsibleTrigger
            type="button"
            className="group flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left text-sm font-medium transition-colors hover:text-accent-foreground"
          >
            <CollapsibleIconTrigger
              icon={Icon}
              className="size-4"
              iconClassName="size-4 text-muted-foreground"
            />
            <span>{title}</span>
          </CollapsibleTrigger>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-slideUp data-[state=open]:animate-slideDown">
          <div className="pt-4">{children}</div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
