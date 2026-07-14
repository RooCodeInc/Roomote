'use client';

import type { TaskRunDetail } from '@/lib/server';

import {
  BasicTooltip,
  CircleX,
  Loader2,
  TriangleAlert,
} from '@/components/system';

interface EnvironmentSetupBadgeProps {
  taskRun?: TaskRunDetail | null;
}

/**
 * Compact status badge for background environment setup (repository setup
 * commands and Docker projects). Environment setup can keep running after
 * the agent has started, so this surfaces its live state next to the task
 * status indicator. Renders nothing when setup never ran in the background
 * (`environmentSetupState` is null) or finished cleanly.
 */
export function EnvironmentSetupBadge({ taskRun }: EnvironmentSetupBadgeProps) {
  const state = taskRun?.environmentSetupState;

  if (!state || state === 'completed') {
    return null;
  }

  if (state === 'running') {
    return (
      <BasicTooltip content="Repository setup commands and Docker projects are still starting in the background.">
        <div
          role="status"
          aria-live="polite"
          className="text-muted-foreground flex cursor-default items-center gap-1.5 text-xs"
        >
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          <span>Setting up environment</span>
        </div>
      </BasicTooltip>
    );
  }

  if (state === 'completed_with_warnings') {
    return (
      <BasicTooltip content="Environment setup finished, but one or more setup steps reported warnings. Ask the agent to check the setup logs if something seems missing.">
        <div
          role="status"
          className="text-warning-foreground flex cursor-default items-center gap-1.5 text-xs"
        >
          <TriangleAlert className="size-3.5 shrink-0" />
          <span>Setup warnings</span>
        </div>
      </BasicTooltip>
    );
  }

  return (
    <BasicTooltip content="Background environment setup failed, so the workspace may be missing dependencies or services. Ask the agent to check the setup logs.">
      <div
        role="status"
        className="text-destructive flex cursor-default items-center gap-1.5 text-xs"
      >
        <CircleX className="size-3.5 shrink-0" />
        <span>Setup failed</span>
      </div>
    </BasicTooltip>
  );
}
