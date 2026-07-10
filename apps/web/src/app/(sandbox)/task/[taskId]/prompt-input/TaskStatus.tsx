'use client';

import { useEffect, useState } from 'react';
import type { TaskRunDetail } from '@/lib/server';

import { TaskStatusIndicator } from '@/components/sandbox';
import { BasicTooltip } from '@/components/system';
import { useSandboxTaskStatusDisplay } from '../hooks/SandboxProvider';
import { parseSleepDeadlineMs } from '../hooks/sleep-deadline';

const MINUTE_MS = 60 * 1_000;
function getDisplaySleepMinutes(ms: number): number {
  return Math.max(1, Math.round(ms / MINUTE_MS));
}

function formatSleepMinutes(ms: number): string {
  return `${getDisplaySleepMinutes(ms)}m`;
}

interface TaskStatusProps {
  taskRun?: TaskRunDetail | null;
}

function isPersistedIdleTaskPhase(
  taskPhase: string | null | undefined,
): boolean {
  return taskPhase === 'idle' || taskPhase === 'waiting_for_prompt';
}

function isLiveSleepBadgePhase(phase: string | null | undefined): boolean {
  return phase === 'idle' || phase === 'waiting_for_prompt';
}

export function TaskStatus({ taskRun }: TaskStatusProps) {
  const { phase, lastErrorMessage } = useSandboxTaskStatusDisplay();

  const sleepDeadlineMs = parseSleepDeadlineMs(taskRun?.sleepAt);

  const showSleepBadge =
    isLiveSleepBadgePhase(phase) &&
    isPersistedIdleTaskPhase(taskRun?.taskPhase);

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
  }, [phase, sleepDeadlineMs, showSleepBadge]);

  useEffect(() => {
    if (!showSleepBadge || sleepDeadlineMs == null) {
      return;
    }

    const sleepRemainingMs = Math.max(0, sleepDeadlineMs - Date.now());

    if (sleepRemainingMs <= 0) {
      return;
    }

    const timeout = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(MINUTE_MS, sleepRemainingMs),
    );

    return () => window.clearTimeout(timeout);
  }, [showSleepBadge, sleepDeadlineMs, now]);

  if (!phase) {
    return null;
  }

  const sleepRemainingMs =
    sleepDeadlineMs == null ? null : Math.max(0, sleepDeadlineMs - now);

  const hasError = Boolean(lastErrorMessage);

  return (
    <div className="flex items-center gap-3">
      <TaskStatusIndicator phase={phase} lastErrorMessage={lastErrorMessage} />
      {!hasError &&
        showSleepBadge &&
        sleepRemainingMs != null &&
        sleepRemainingMs > 0 && (
          <BasicTooltip content="Approximate time until this task goes to sleep.">
            <span className="text-muted-foreground tabular-nums text-xs mr-2 cursor-default">
              {formatSleepMinutes(sleepRemainingMs)}
            </span>
          </BasicTooltip>
        )}
    </div>
  );
}
