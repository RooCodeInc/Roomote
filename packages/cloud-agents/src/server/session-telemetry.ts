import { captureEvent } from '@roomote/telemetry/server';
import type { TaskSurface, TaskTrigger } from '@roomote/types';

export function captureUserStartedSessionCreated(input: {
  userId: string;
  surface: TaskSurface;
  trigger: TaskTrigger;
}): void {
  void captureEvent('session_created', {
    userId: input.userId,
    properties: {
      surface: input.surface,
      trigger: input.trigger,
      outcome: 'created',
    },
  });
}
