import type { TaskPhase } from '@roomote/types';

type TaskNotificationSessionState =
  | 'interactive'
  | 'booting'
  | 'resuming'
  | 'boot-failed'
  | 'historical'
  | 'not-found'
  | 'error';

export function getTaskNotificationPhase({
  sessionState,
  liveTaskPhase,
  persistedTaskPhase,
}: {
  sessionState: TaskNotificationSessionState;
  liveTaskPhase: TaskPhase | null;
  persistedTaskPhase: TaskPhase | null | undefined;
}): TaskPhase | undefined {
  if (sessionState === 'interactive') {
    return liveTaskPhase ?? undefined;
  }

  return persistedTaskPhase ?? undefined;
}
