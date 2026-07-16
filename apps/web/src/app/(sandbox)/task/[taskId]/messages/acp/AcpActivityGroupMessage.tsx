'use client';

import type { ReactNode } from 'react';

import {
  ChevronRight,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/system';
import { cn } from '@/lib/utils';

import type { AcpActivityGroupRenderBlock } from './activity-groups';

interface AcpActivityGroupMessageProps {
  group: AcpActivityGroupRenderBlock;
  anchorIds?: string[];
  children: ReactNode;
}

export function AcpActivityGroupMessage({
  group,
  anchorIds = [],
  children,
}: AcpActivityGroupMessageProps) {
  return (
    <Collapsible
      defaultOpen={false}
      className="group/acp-activity my-3"
      data-testid="acp-activity-group"
    >
      {anchorIds.map((anchorId) => (
        <div
          key={anchorId}
          id={anchorId}
          aria-hidden="true"
          className="h-0 overflow-hidden"
        />
      ))}
      <div className="flex items-center gap-3">
        <CollapsibleTrigger
          className={cn(
            'flex shrink-0 cursor-pointer items-center gap-1.5 text-sm font-light text-muted-foreground transition-colors hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          )}
        >
          <ChevronRight className="size-4 transition-transform group-data-[state=open]/acp-activity:rotate-90" />
          <span>Worked for {formatWorkedDuration(group.endTs - group.ts)}</span>
        </CollapsibleTrigger>
        <div
          className="h-px min-w-8 flex-1 border-t border-border/20 relative top-px"
          aria-hidden="true"
        />
      </div>
      <CollapsibleContent className="mt-4 space-y-0 border-l border-border pl-4 ml-2 data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=open]:animate-in">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function formatWorkedDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (totalSeconds < 13) {
    return 'a bit';
  }

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  return `${seconds}s`;
}
