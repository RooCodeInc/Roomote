vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      setPendingLinearRequestUserInput: vi.fn().mockResolvedValue(undefined),
      clearPendingLinearRequestUserInput: vi.fn().mockResolvedValue(true),
    },
    linearSessions: {
      emitThought: vi.fn().mockResolvedValue(undefined),
      emitResponse: vi.fn().mockResolvedValue(undefined),
      emitElicitation: vi.fn().mockResolvedValue(undefined),
      emitAction: vi.fn().mockResolvedValue(undefined),
      updateSessionPlan: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

import { TaskPayloadKind } from '@roomote/types';
import { type TaskRun, sdk } from '@roomote/sdk/client';

import {
  getLinearSessionActivityStreamCallbacks,
  linearAgentCallbacks,
} from '../linear-agent';

function createTaskRun(): TaskRun {
  return {
    id: 123,
    taskId: 'task_123',
    payloadKind: TaskPayloadKind.LinearAgentSession,
    payload: { sessionId: 'session_123' },
  } as unknown as TaskRun;
}

function createLinearFastChildRun(): TaskRun {
  return {
    id: 124,
    taskId: 'task_124',
    payloadKind: TaskPayloadKind.StandardTask,
    payload: {
      repo: '__all_repositories__',
      description: 'Fix the retry loop',
      reportConsumer: 'orchestrator',
      fastAgentSessionId: '11111111-1111-4111-8111-111111111111',
      fastAgentParent: {
        sessionId: '11111111-1111-4111-8111-111111111111',
        conversation: {
          surface: 'linear',
          workspaceId: 'org-1',
          conversationId: 'agent-session-9',
          replyTarget: { channelId: 'agent-session-9' },
        },
      },
    },
  } as unknown as TaskRun;
}

describe('linearAgentCallbacks', () => {
  const setPendingLinearRequestUserInputMock = vi.mocked(
    sdk.taskRuns.setPendingLinearRequestUserInput,
  );
  const emitActionMock = vi.mocked(sdk.linearSessions.emitAction);
  const emitElicitationMock = vi.mocked(sdk.linearSessions.emitElicitation);
  const emitResponseMock = vi.mocked(sdk.linearSessions.emitResponse);
  const updateSessionPlanMock = vi.mocked(sdk.linearSessions.updateSessionPlan);

  beforeEach(() => {
    setPendingLinearRequestUserInputMock.mockClear();
    emitActionMock.mockClear();
    emitElicitationMock.mockClear();
    emitResponseMock.mockClear();
    updateSessionPlanMock.mockClear();
  });

  it('processes distinct same-timestamp events', async () => {
    const context = {};
    const taskRun = createTaskRun();

    await linearAgentCallbacks.onStart?.(taskRun, 'task_123', context);

    await linearAgentCallbacks.onMessage?.(
      taskRun,
      'task_123',
      {
        type: 'tool_action',
        usage: { action: 'Read file', details: 'README.md' },
        ts: 1000,
      },
      context,
    );

    await linearAgentCallbacks.onMessage?.(
      taskRun,
      'task_123',
      {
        type: 'todo_update',
        todos: [
          { id: '1', content: 'First', status: 'pending' },
          { id: '2', content: 'Second', status: 'completed' },
        ],
        ts: 1000,
      },
      context,
    );

    expect(emitActionMock).toHaveBeenCalledWith(
      'session_123',
      'Read file',
      'README.md',
    );
    expect(updateSessionPlanMock).toHaveBeenCalledTimes(1);
  });

  it('dedupes exact duplicate same-timestamp events', async () => {
    const context = {};
    const taskRun = createTaskRun();

    const event = {
      type: 'todo_update' as const,
      todos: [{ id: '1', content: 'Only item', status: 'pending' as const }],
      ts: 2000,
    };

    await linearAgentCallbacks.onMessage?.(taskRun, 'task_123', event, context);
    await linearAgentCallbacks.onMessage?.(taskRun, 'task_123', event, context);

    expect(updateSessionPlanMock).toHaveBeenCalledTimes(1);
  });

  it('does not let a synthetic turn start suppress earlier persisted events', async () => {
    const context = {};
    const taskRun = createTaskRun();

    await linearAgentCallbacks.onMessage?.(
      taskRun,
      'task_123',
      { type: 'turn_started', ts: 2000 },
      context,
    );
    await linearAgentCallbacks.onMessage?.(
      taskRun,
      'task_123',
      { type: 'completion', text: 'Completed.', ts: 1000 },
      context,
    );

    expect(emitResponseMock).toHaveBeenCalledWith('session_123', 'Completed.');
  });

  it('stores pending request_user_input via sdk.taskRuns before emitting the elicitation', async () => {
    const context = {};
    const taskRun = createTaskRun();

    await linearAgentCallbacks.onMessage?.(
      taskRun,
      'task_123',
      {
        type: 'request_user_input',
        request: {
          requestId: 'rui:session_123:turn_1:call_1',
          sessionId: 'session_123',
          turnId: 'turn_1',
          callId: 'call_1',
          questions: [
            {
              id: 'language',
              header: 'Language',
              question: 'Which language should I use?',
              isOther: true,
              isSecret: false,
              options: [
                {
                  label: 'TypeScript',
                  description: 'Use the existing app stack.',
                },
                {
                  label: 'Rust',
                  description: 'Use the OpenCode runtime.',
                },
              ],
            },
          ],
          status: 'pending',
        },
        ts: 3000,
      },
      context,
    );

    expect(setPendingLinearRequestUserInputMock).toHaveBeenCalledWith({
      runId: 123,
      sessionId: 'session_123',
      requestId: 'rui:session_123:turn_1:call_1',
      taskId: 'task_123',
      questions: [
        {
          id: 'language',
          header: 'Language',
          question: 'Which language should I use?',
          isOther: true,
          isSecret: false,
          options: [
            {
              label: 'TypeScript',
              description: 'Use the existing app stack.',
            },
            {
              label: 'Rust',
              description: 'Use the OpenCode runtime.',
            },
          ],
        },
      ],
    });
    expect(emitElicitationMock).toHaveBeenCalledTimes(1);
    expect(
      setPendingLinearRequestUserInputMock.mock.invocationCallOrder[0],
    ).toBeLessThan(emitElicitationMock.mock.invocationCallOrder[0]!);
  });

  it('re-emits request_user_input when the same request id receives richer questions', async () => {
    const context = {};
    const taskRun = createTaskRun();
    const requestId = 'rui:session_123:turn_1:call_1';
    const placeholderQuestion = {
      id: 'response',
      header: 'Response',
      question: 'Provide the requested input.',
      isOther: true,
      isSecret: false,
    };
    const richQuestion = {
      id: 'language',
      header: 'Language',
      question: 'Which language should I use?',
      isOther: true,
      isSecret: false,
      options: [
        {
          label: 'TypeScript',
          description: 'Use the existing app stack.',
        },
        {
          label: 'Rust',
          description: 'Use the OpenCode runtime.',
        },
      ],
    };

    await linearAgentCallbacks.onMessage?.(
      taskRun,
      'task_123',
      {
        type: 'request_user_input',
        request: {
          requestId,
          sessionId: 'session_123',
          turnId: 'turn_1',
          callId: 'call_1',
          questions: [placeholderQuestion],
          status: 'pending',
        },
        ts: 3000,
      },
      context,
    );

    await linearAgentCallbacks.onMessage?.(
      taskRun,
      'task_123',
      {
        type: 'request_user_input',
        request: {
          requestId,
          sessionId: 'session_123',
          turnId: 'turn_1',
          callId: 'call_1',
          questions: [richQuestion],
          status: 'pending',
        },
        ts: 3001,
      },
      context,
    );

    // Placeholder OpenCode shells are skipped; only the richer question posts.
    expect(setPendingLinearRequestUserInputMock).toHaveBeenCalledTimes(1);
    expect(setPendingLinearRequestUserInputMock).toHaveBeenLastCalledWith({
      runId: 123,
      sessionId: 'session_123',
      requestId,
      taskId: 'task_123',
      questions: [richQuestion],
    });
    expect(emitElicitationMock).toHaveBeenCalledTimes(1);
    expect(emitElicitationMock).toHaveBeenLastCalledWith(
      'session_123',
      expect.stringContaining('Which language should I use?'),
      {
        signal: 'select',
        signalMetadata: {
          options: [{ value: 'TypeScript' }, { value: 'Rust' }],
        },
      },
    );
  });

  it('streams a Linear Fast child’s activity into its parent agent session', async () => {
    const context = {};
    const taskRun = createLinearFastChildRun();
    const callbacks = getLinearSessionActivityStreamCallbacks(taskRun);

    await callbacks.onStart?.(taskRun, 'task_124', context);
    await callbacks.onMessage?.(
      taskRun,
      'task_124',
      {
        type: 'tool_action',
        usage: { action: 'Read file', details: 'README.md' },
        ts: 1000,
      },
      context,
    );

    expect(emitActionMock).toHaveBeenCalledWith(
      'agent-session-9',
      'Read file',
      'README.md',
    );
  });

  it('leaves the final response to the Fast Session for a delegated child', async () => {
    const context = {};
    const taskRun = createLinearFastChildRun();

    await linearAgentCallbacks.onStart?.(taskRun, 'task_124', context);
    await linearAgentCallbacks.onMessage?.(
      taskRun,
      'task_124',
      { type: 'completion', text: 'All done.', ts: 2000 },
      context,
    );

    expect(emitResponseMock).not.toHaveBeenCalled();
    expect(context).toMatchObject({ isCompleted: true });
  });

  it('adds no stream for runs without a Linear Fast parent', () => {
    expect(
      getLinearSessionActivityStreamCallbacks({
        id: 1,
        taskId: 'task_1',
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { repo: 'acme/app' },
      } as unknown as TaskRun),
    ).toEqual({});
    expect(getLinearSessionActivityStreamCallbacks(createTaskRun())).toEqual(
      {},
    );
  });
});
