'use client';

import { useEffect, useMemo, useState } from 'react';

import {
  TodoList as TodoListPrimitive,
  TodoListItem,
  TodoListItemContent,
  TodoListItemIndicator,
  TodoListItems,
  TodoListSection,
  TodoListSectionContent,
  TodoListSectionLabel,
  TodoListSectionTrigger,
} from '@/components/ai-elements';
import { sanitizeSandboxPathString } from '@/lib';

import {
  useIsInsideSandboxProvider,
  useSandboxMessages,
  useSandboxTaskPhase,
} from './hooks/SandboxProvider';
import { useInternalTranscriptRowsVisible } from './useInternalTranscriptRowsVisible';
import { getActiveSubtasks } from './active-subtasks';

const SUBTASK_INACTIVE_TASK_PHASES: ReadonlySet<string> = new Set([
  'idle',
  'waiting_for_prompt',
  'stopped',
  'shutting_down',
]);

interface ActiveSubtasksListProps {
  taskEntryKey?: string;
}

function formatActiveSubtaskRuntime(startedAt: number, now: number): string {
  const elapsedMs = Math.max(0, now - startedAt);
  const elapsedSeconds = Math.max(1, Math.floor(elapsedMs / 1000));

  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);

  if (elapsedHours < 24) {
    const remainingMinutes = elapsedMinutes % 60;
    return remainingMinutes > 0
      ? `${elapsedHours}h ${remainingMinutes}m`
      : `${elapsedHours}h`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  const remainingHours = elapsedHours % 24;

  return remainingHours > 0
    ? `${elapsedDays}d ${remainingHours}h`
    : `${elapsedDays}d`;
}

export function ActiveSubtasksList({ taskEntryKey }: ActiveSubtasksListProps) {
  const isInsideProvider = useIsInsideSandboxProvider();

  if (!isInsideProvider) {
    return null;
  }

  return <ActiveSubtasksListContent taskEntryKey={taskEntryKey} />;
}

function ActiveSubtasksListContent({ taskEntryKey }: ActiveSubtasksListProps) {
  const { messages } = useSandboxMessages();
  const taskPhase = useSandboxTaskPhase();
  const showInternalTranscriptRows = useInternalTranscriptRowsVisible();
  const activeSubtasks = useMemo(() => getActiveSubtasks(messages), [messages]);
  const [isOpen, setIsOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!taskEntryKey) {
      return;
    }

    setIsOpen(false);
  }, [taskEntryKey]);

  useEffect(() => {
    if (activeSubtasks.length === 0) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeSubtasks.length]);

  if (!showInternalTranscriptRows) {
    return null;
  }

  if (taskPhase != null && SUBTASK_INACTIVE_TASK_PHASES.has(taskPhase)) {
    return null;
  }

  if (activeSubtasks.length === 0) {
    return null;
  }

  return (
    <div className="overflow-hidden border-b border-background">
      <TodoListPrimitive>
        <TodoListSection onOpenChange={setIsOpen} open={isOpen}>
          <TodoListSectionTrigger>
            <TodoListSectionLabel
              count={activeSubtasks.length}
              label={
                activeSubtasks.length === 1
                  ? 'active subagent'
                  : 'active subagents'
              }
            />
          </TodoListSectionTrigger>
          <TodoListSectionContent>
            <TodoListItems>
              {activeSubtasks.map((subtask) => (
                <TodoListItem
                  key={subtask.id}
                  className="flex-row items-start gap-2"
                  inProgress={subtask.status === 'in_progress'}
                >
                  <TodoListItemIndicator
                    className="mt-0.5 shrink-0"
                    inProgress={subtask.status === 'in_progress'}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-3">
                      <TodoListItemContent className="line-clamp-2 text-foreground">
                        {sanitizeSandboxPathString(subtask.name)}
                      </TodoListItemContent>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
                        {formatActiveSubtaskRuntime(subtask.startedAt, now)}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground/70">
                      {sanitizeSandboxPathString(
                        subtask.status === 'pending'
                          ? `${subtask.agentTypeLabel} · starting`
                          : subtask.agentTypeLabel,
                      )}
                    </div>
                  </div>
                </TodoListItem>
              ))}
            </TodoListItems>
          </TodoListSectionContent>
        </TodoListSection>
      </TodoListPrimitive>
    </div>
  );
}
