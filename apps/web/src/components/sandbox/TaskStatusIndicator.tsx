'use client';

import {
  CloudTaskStatus,
  isBootingCloudTaskStatus,
  TASK_PHASES,
  type CloudTaskStatus as CloudTaskStatusType,
  type TaskPhase,
} from '@roomote/types';

import { BasicTooltip } from '@/components/system';
import { cn } from '@/lib/utils';

const phaseConfig: Record<TaskPhase, { label: string; color: string }> = {
  idle: { label: 'Idle', color: 'text-muted-foreground' },
  waiting_for_prompt: { label: 'Ready', color: 'text-emerald-500' },
  waiting_for_user_input: {
    label: 'Needs input',
    color: 'text-accent-foreground',
  },
  running: { label: 'Working', color: 'text-emerald-500' },
  stopped: { label: 'Stopped', color: 'text-yellow-500' },
  shutting_down: { label: 'Terminating', color: 'text-red-500' },
};

function toTaskPhase(phase?: string | null): TaskPhase | null {
  if (phase && (TASK_PHASES as readonly string[]).includes(phase)) {
    return phase as TaskPhase;
  }
  return null;
}

function resolveTaskPhase({
  phase,
  status,
}: {
  phase?: string | null;
  status?: CloudTaskStatusType | null;
}): TaskPhase | null {
  const phaseStatus = toTaskPhase(phase);

  if (phaseStatus) {
    return phaseStatus;
  }

  if (!status) {
    return null;
  }

  if (
    status === CloudTaskStatus.Failed ||
    status === CloudTaskStatus.Canceled
  ) {
    return 'shutting_down';
  }

  if (isBootingCloudTaskStatus(status) || status === CloudTaskStatus.Running) {
    return 'running';
  }

  if (status === CloudTaskStatus.Idle) {
    return 'idle';
  }

  return 'idle';
}

type TaskStatusIndicatorProps = {
  phase?: string | null;
  status?: CloudTaskStatusType | null;
  lastErrorMessage?: string | null;
  compact?: boolean;
  className?: string;
  dotClassName?: string;
  labelClassName?: string;
};

export function TaskStatusIndicator({
  phase,
  status,
  lastErrorMessage,
  compact = false,
  className,
  dotClassName,
  labelClassName,
}: TaskStatusIndicatorProps) {
  const resolvedPhaseStatus = resolveTaskPhase({ phase, status });

  if (!resolvedPhaseStatus) {
    return null;
  }

  const hasError = Boolean(lastErrorMessage);
  const { label, color } = phaseConfig[resolvedPhaseStatus];
  const statusLabel = hasError ? 'Error' : label;
  const statusColor = hasError ? 'text-red-500' : color;
  const isRunning = !hasError && resolvedPhaseStatus === 'running';

  const dot = (
    <span className={cn('relative flex size-2', dotClassName)}>
      {isRunning && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-75" />
      )}
      <span className="relative inline-flex size-2 rounded-full bg-current" />
    </span>
  );

  if (compact) {
    return (
      <span className={cn('inline-flex items-center', statusColor, className)}>
        {dot}
      </span>
    );
  }

  return (
    <span
      className={cn(
        'flex items-center cursor-default gap-1',
        statusColor,
        className,
      )}
    >
      {dot}
      {hasError && lastErrorMessage ? (
        <BasicTooltip content={lastErrorMessage}>
          <span className={cn('truncate max-w-64 text-xs', labelClassName)}>
            {statusLabel}
          </span>
        </BasicTooltip>
      ) : (
        <span className={cn('text-xs', labelClassName)}>{statusLabel}</span>
      )}
    </span>
  );
}
