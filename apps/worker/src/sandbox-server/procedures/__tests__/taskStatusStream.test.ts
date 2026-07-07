import type {
  TaskPhase,
  TaskStateEvent,
  TaskStatusEvent,
} from '@roomote/types';

import { normalizeTaskStatusEventForClient } from '../taskStatusStream';

function createStatus(phase: TaskPhase): TaskStatusEvent {
  return {
    phase,
    taskStateEvent: null as TaskStateEvent | null,
    sessionId: 'task-1',
    isConnected: true,
    sleepRemainingMs: 15_000,
    lastErrorMessage: undefined,
  };
}

describe('normalizeTaskStatusEventForClient', () => {
  it('keeps running status unchanged', () => {
    const status = createStatus('running');
    const normalized = normalizeTaskStatusEventForClient(status);

    expect(normalized).toEqual(status);
  });

  it('keeps waiting_for_user_input status unchanged', () => {
    const status = createStatus('waiting_for_user_input');
    const normalized = normalizeTaskStatusEventForClient(status);

    expect(normalized).toEqual(status);
  });

  it('collapses running status to idle when disconnected', () => {
    const status = {
      ...createStatus('running'),
      isConnected: false,
    };
    const normalized = normalizeTaskStatusEventForClient(status);

    expect(normalized.phase).toBe('idle');
    expect(normalized.isConnected).toBe(false);
  });

  it.each(['idle', 'waiting_for_prompt', 'stopped', 'shutting_down'] as const)(
    'collapses phase %s to idle',
    (phase) => {
      const status = createStatus(phase);
      const normalized = normalizeTaskStatusEventForClient(status);

      expect(normalized.phase).toBe('idle');
      expect(normalized.sessionId).toBe(status.sessionId);
      expect(normalized.sleepRemainingMs).toBe(status.sleepRemainingMs);
      expect(normalized.lastErrorMessage).toBe(status.lastErrorMessage);
    },
  );
});
