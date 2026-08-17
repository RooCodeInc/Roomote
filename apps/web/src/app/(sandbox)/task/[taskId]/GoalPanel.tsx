'use client';

import { useEffect, useState } from 'react';
import type { TaskGoalStatus } from '@roomote/types';

import { TodoList as TodoListPrimitive } from '@/components/ai-elements';
import {
  BasicTooltip,
  CircleAlert,
  CircleCheck,
  LoaderCircle,
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
        label: 'Pursuing goal',
        Icon: LoaderCircle,
      };
    case 'complete':
      return {
        label: 'Goal complete',
        Icon: CircleCheck,
      };
    case 'blocked':
      return {
        label: 'Goal blocked',
        Icon: CircleAlert,
      };
    case 'budget_limited':
      return {
        label: 'Continuation limit reached',
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
        <section
          className="flex min-w-0 items-center gap-1.5 px-4 py-2 text-sm"
          data-testid="goal-panel"
        >
          <Icon
            className={
              status === 'active'
                ? 'size-4 shrink-0 animate-spin text-muted-foreground'
                : 'size-4 shrink-0 text-muted-foreground'
            }
          />
          <span
            className="shrink-0 font-semibold text-foreground"
            data-testid="goal-status"
          >
            {presentation.label}
          </span>
          <BasicTooltip content={objective}>
            <span
              className="min-w-0 truncate text-muted-foreground"
              data-testid="goal-objective"
              title={objective}
            >
              {objective}
            </span>
          </BasicTooltip>
          <span
            className="shrink-0 text-muted-foreground/60"
            data-testid="goal-separator"
            aria-hidden="true"
          >
            ·
          </span>
          <span
            className="shrink-0 tabular-nums text-muted-foreground"
            data-testid="goal-duration"
            aria-label={duration ?? 'Duration unavailable'}
            title={duration ? undefined : 'Duration unavailable'}
          >
            {duration ?? 'N/A'}
          </span>
        </section>
      </TodoListPrimitive>
    </div>
  );
}
