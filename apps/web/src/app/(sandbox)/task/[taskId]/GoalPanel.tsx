'use client';

import { useEffect, useState } from 'react';
import type { TaskGoalStatus } from '@roomote/types';

import { TodoList as TodoListPrimitive } from '@/components/ai-elements';
import {
  Badge,
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  Sparkles,
} from '@/components/system';

import type { TaskSession } from './hooks/use-task-session';

const SECOND_MS = 1_000;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;

function formatDurationPart(value: number, suffix: string): string {
  return value > 0 ? `${value}${suffix}` : '';
}

function formatGoalDuration(
  startedAt: Date | null | undefined,
  endedAt: Date | null | undefined,
  now: number,
): string | null {
  if (!startedAt) {
    return null;
  }

  const elapsedSeconds = Math.max(
    0,
    Math.floor(((endedAt?.getTime() ?? now) - startedAt.getTime()) / SECOND_MS),
  );
  const days = Math.floor(elapsedSeconds / DAY_SECONDS);
  const hours = Math.floor((elapsedSeconds % DAY_SECONDS) / HOUR_SECONDS);
  const minutes = Math.floor((elapsedSeconds % HOUR_SECONDS) / MINUTE_SECONDS);
  const seconds = elapsedSeconds % MINUTE_SECONDS;

  if (days > 0) {
    return [formatDurationPart(days, 'd'), formatDurationPart(hours, 'h')]
      .filter(Boolean)
      .join(' ');
  }

  if (hours > 0) {
    return [formatDurationPart(hours, 'h'), formatDurationPart(minutes, 'm')]
      .filter(Boolean)
      .join(' ');
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function getGoalPresentation(status: TaskGoalStatus) {
  switch (status) {
    case 'active':
      return {
        label: 'Active',
        durationPrefix: 'Active for',
        badgeVariant: 'default' as const,
        Icon: LoaderCircle,
      };
    case 'complete':
      return {
        label: 'Complete',
        durationPrefix: 'Completed after',
        badgeVariant: 'success' as const,
        Icon: CircleCheck,
      };
    case 'blocked':
      return {
        label: 'Blocked',
        durationPrefix: 'Blocked after',
        badgeVariant: 'warning' as const,
        Icon: CircleAlert,
      };
    case 'budget_limited':
      return {
        label: 'Continuation limit reached',
        durationPrefix: 'Limit reached after',
        badgeVariant: 'warning' as const,
        Icon: CircleAlert,
      };
  }
}

export function GoalPanel({ task }: { task: TaskSession['task'] }) {
  const objective = task?.goalObjective?.trim();
  const status = task?.goalStatus;
  const startedAtMs = task?.goalStartedAt?.getTime() ?? null;
  const [, setTick] = useState(0);

  useEffect(() => {
    if (status !== 'active' || startedAtMs === null) {
      return;
    }

    const intervalId = window.setInterval(
      () => setTick((current) => current + 1),
      SECOND_MS,
    );
    return () => window.clearInterval(intervalId);
  }, [startedAtMs, status]);

  if (!objective || !status) {
    return null;
  }

  const presentation = getGoalPresentation(status);
  const endedAt = status === 'active' ? null : task.goalEndedAt;
  const duration =
    status !== 'active' && !endedAt
      ? null
      : formatGoalDuration(task.goalStartedAt, endedAt, Date.now());
  const { Icon } = presentation;

  return (
    <div className="overflow-hidden border-b border-background">
      <TodoListPrimitive className="mx-auto w-full max-w-4xl">
        <section className="px-4 py-3" data-testid="goal-panel">
          <div className="flex flex-wrap items-center gap-2">
            <Sparkles className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">
              Current goal
            </span>
            <Badge variant={presentation.badgeVariant}>
              <Icon
                className={status === 'active' ? 'animate-spin' : undefined}
              />
              {presentation.label}
            </Badge>
            <span
              className="ml-auto text-xs tabular-nums text-muted-foreground"
              data-testid="goal-duration"
            >
              {duration
                ? `${presentation.durationPrefix} ${duration}`
                : 'Duration unavailable'}
            </span>
          </div>
          <p className="mt-2 whitespace-pre-wrap wrap-break-word text-sm font-medium text-foreground">
            {objective}
          </p>
          {status === 'blocked' && task.goalBlockedReason ? (
            <p className="mt-1 whitespace-pre-wrap wrap-break-word text-xs text-muted-foreground">
              {task.goalBlockedReason}
            </p>
          ) : null}
        </section>
      </TodoListPrimitive>
    </div>
  );
}
