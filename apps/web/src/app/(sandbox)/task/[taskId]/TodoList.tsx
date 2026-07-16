'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

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

import {
  useIsInsideSandboxProvider,
  useSandboxTaskPhase,
  useSandboxTodos,
} from './hooks/SandboxProvider';
import { getDisplayedTodoStatus } from './todo-status';

const TODO_INACTIVE_TASK_PHASES: ReadonlySet<string> = new Set([
  'idle',
  'waiting_for_prompt',
  'stopped',
  'shutting_down',
]);

/**
 * TodoList wrapper that safely handles being rendered outside of SandboxProvider.
 * This is needed because Header renders TodoList in fallback/loading states
 * before the provider is available.
 */
interface TodoListProps {
  autoCollapseKey?: string | null;
  taskEntryKey?: string;
}

export const TodoList = ({ autoCollapseKey, taskEntryKey }: TodoListProps) => {
  const isInsideProvider = useIsInsideSandboxProvider();

  if (!isInsideProvider) {
    return null;
  }

  return (
    <TodoListContent
      autoCollapseKey={autoCollapseKey}
      taskEntryKey={taskEntryKey}
    />
  );
};

const TodoListContent = ({ autoCollapseKey, taskEntryKey }: TodoListProps) => {
  const todos = useSandboxTodos();
  const taskPhase = useSandboxTaskPhase();
  const shouldSuppressActiveStatus =
    taskPhase != null && TODO_INACTIVE_TASK_PHASES.has(taskPhase);

  const todoStatusSignature = useMemo(
    () => todos.map((todo) => `${todo.id}:${todo.status}`).join('|'),
    [todos],
  );

  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const allDone = todos.length > 0 && completedCount === todos.length;
  const [isOpen, setIsOpen] = useState(false);
  const autoCollapsedKeysRef = useRef(new Set<string>());
  const wasAllDoneRef = useRef(allDone);

  useLayoutEffect(() => {
    if (!taskEntryKey) {
      return;
    }

    autoCollapsedKeysRef.current.clear();

    const mobileQuery = window.matchMedia?.('(max-width: 767px)');

    if (!mobileQuery?.matches) {
      return;
    }

    wasAllDoneRef.current = false;
    setIsOpen(false);
  }, [taskEntryKey]);

  useEffect(() => {
    if (!autoCollapseKey) {
      return;
    }

    if (autoCollapsedKeysRef.current.has(autoCollapseKey)) {
      return;
    }

    autoCollapsedKeysRef.current.add(autoCollapseKey);
    setIsOpen(false);
  }, [autoCollapseKey]);

  useEffect(() => {
    if (!allDone) {
      if (wasAllDoneRef.current) {
        setIsOpen(true);
      }
      wasAllDoneRef.current = false;
      return;
    }

    wasAllDoneRef.current = true;
    setIsOpen(false);
  }, [allDone, todoStatusSignature]);

  if (todos.length === 0) {
    return null;
  }

  return (
    <div className="overflow-hidden border-b border-background">
      <TodoListPrimitive className="mx-auto w-full max-w-4xl">
        <TodoListSection
          allCompleted={allDone}
          onOpenChange={setIsOpen}
          open={isOpen}
        >
          <TodoListSectionTrigger>
            <TodoListSectionLabel
              label={
                allDone
                  ? `All ${completedCount} to-dos done`
                  : `${completedCount} of ${todos.length} to-dos done`
              }
            />
          </TodoListSectionTrigger>
          <TodoListSectionContent>
            <TodoListItems>
              {todos.map((todo, i) => {
                const status = getDisplayedTodoStatus(
                  todo,
                  i,
                  todos,
                  shouldSuppressActiveStatus,
                );
                const completed = status === 'completed';
                const inProgress = status === 'in_progress';

                return (
                  <TodoListItem
                    key={todo.id}
                    className="flex-row items-center"
                    completed={completed}
                    inProgress={inProgress}
                  >
                    <TodoListItemIndicator
                      completed={completed}
                      inProgress={inProgress}
                    />
                    <TodoListItemContent>{todo.content}</TodoListItemContent>
                  </TodoListItem>
                );
              })}
            </TodoListItems>
          </TodoListSectionContent>
        </TodoListSection>
      </TodoListPrimitive>
    </div>
  );
};
