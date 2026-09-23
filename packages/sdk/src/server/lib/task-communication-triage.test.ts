import { describe, expect, it } from 'vitest';

import { getTaskCommunicationFallback } from './task-communication-triage';

describe('getTaskCommunicationFallback', () => {
  it('delivers a child question even when optional activity triage is unavailable', () => {
    expect(
      getTaskCommunicationFallback({
        type: 'task_activity',
        taskId: 'task-1',
        runId: 1,
        items: [
          { kind: 'question', text: 'Which option should I use?' },
          { kind: 'tools', text: 'git status' },
        ],
      }),
    ).toEqual({
      kind: 'deliver',
      hint: { decision: 'relay', reason: 'task_question' },
    });
  });

  it('continues to suppress non-question activity without triage', () => {
    expect(
      getTaskCommunicationFallback({
        type: 'task_activity',
        taskId: 'task-1',
        runId: 1,
        items: [{ kind: 'tools', text: 'git status' }],
      }),
    ).toEqual({ kind: 'skip' });
  });

  it('continues to deliver explicit child reports without triage', () => {
    expect(
      getTaskCommunicationFallback({
        type: 'child_message',
        taskId: 'task-1',
        runId: 1,
        purpose: 'clarification',
        message: 'Which option should I use?',
      }),
    ).toEqual({ kind: 'deliver' });
  });
});
