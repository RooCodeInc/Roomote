const mocks = vi.hoisted(() => ({
  enqueueTask: vi.fn(),
  getTaskUrl: vi.fn(() => 'https://roomote.example/task/task-1'),
  getOrCreateFastAgentSession: vi.fn(),
  upsertFastAgentMessage: vi.fn(),
  findById: vi.fn(),
  taskRunsFindFirst: vi.fn(),
  getSessionForFastConversation: vi.fn(),
}));

vi.mock('../../task-run-queue', () => ({
  enqueueTask: mocks.enqueueTask,
}));

vi.mock('../../task-url', () => ({
  getTaskUrl: mocks.getTaskUrl,
}));

vi.mock('../fast-agent-session', () => ({
  getOrCreateFastAgentSession: mocks.getOrCreateFastAgentSession,
  upsertFastAgentMessage: mocks.upsertFastAgentMessage,
}));

vi.mock('../fast-agent-conversation-repository', () => ({
  fastAgentConversationRepository: { findById: mocks.findById },
}));

vi.mock('@roomote/db/server', () => ({
  db: { query: { taskRuns: { findFirst: mocks.taskRunsFindFirst } } },
  and: vi.fn((...parts: unknown[]) => ({ and: parts })),
  desc: vi.fn((column: unknown) => ({ desc: column })),
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  isNull: vi.fn((column: unknown) => ({ isNull: column })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      sql: strings.join('?'),
      values,
    })),
    { raw: vi.fn() },
  ),
  taskRuns: {
    taskId: 'task_runs.task_id',
    createdAt: 'c',
    id: 'i',
    payload: 'task_runs.payload',
    canceledAt: 'task_runs.canceled_at',
  },
  getSessionForFastConversation: mocks.getSessionForFastConversation,
}));

import {
  ACP_ENVELOPE_EVENT_TYPES,
  TaskPayloadKind,
  type StandardTask,
} from '@roomote/types';

import { launchPinnedFastSessionTask } from '../fast-agent-pinned-launch';

const task: StandardTask = {
  type: TaskPayloadKind.StandardTask,
  harness: 'opencode-server',
  payload: {
    repo: 'acme/api',
    branch: 'main',
    environmentId: 'env-1',
    description: 'Fix the flaky test',
    blank: false,
  },
};

describe('launchPinnedFastSessionTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrCreateFastAgentSession.mockResolvedValue({
      id: 'fast-1',
      created: true,
      conversation: {
        surface: 'web',
        workspaceId: 'user-1',
        conversationId: 'conv-1',
      },
    });
    mocks.upsertFastAgentMessage.mockResolvedValue({
      initialHumanTurn: true,
    });
    mocks.enqueueTask.mockImplementation(
      async (
        _input: unknown,
        options: {
          beforeEnqueue: (taskRun: {
            id: number;
            taskId: string;
          }) => Promise<void>;
        },
      ) => {
        await options.beforeEnqueue({ id: 7, taskId: 'task-1' });
        return { id: 7, taskId: 'task-1' };
      },
    );
    mocks.taskRunsFindFirst.mockResolvedValue({ id: 7 });
    mocks.getSessionForFastConversation.mockResolvedValue({ id: 'session-1' });
  });

  it('creates a web session, records the request and kickoff, and delegates the task', async () => {
    const result = await launchPinnedFastSessionTask({
      userId: 'user-1',
      senderDisplayName: 'User One',
      launchId: 'launch-1',
      prompt: 'Fix the flaky test',
      task,
      surface: 'web',
      kickoffMessage: 'Started a task in Backend.',
    });

    expect(result).toEqual({
      sessionId: 'session-1',
      fastConversationId: 'fast-1',
      taskId: 'task-1',
      runId: 7,
    });
    expect(mocks.getOrCreateFastAgentSession).toHaveBeenCalledWith({
      userId: 'user-1',
      conversation: expect.objectContaining({
        surface: 'web',
        workspaceId: 'user-1',
      }),
    });

    const [userWrite, kickoffWrite] = mocks.upsertFastAgentMessage.mock.calls;
    expect(userWrite?.[0]).toEqual({
      sessionId: 'fast-1',
      message: expect.objectContaining({
        eventId: 'pinned-launch:launch-1:user',
        turnId: 'pinned-launch:launch-1',
        turnSeq: 0,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'Fix the flaky test' }],
        metadata: expect.objectContaining({
          visibleInTranscript: true,
          turnSource: 'human',
          userId: 'user-1',
          senderDisplayName: 'User One',
        }),
        source: 'web',
      }),
    });
    expect(kickoffWrite?.[0]).toEqual({
      sessionId: 'fast-1',
      message: expect.objectContaining({
        eventId: 'pinned-launch:launch-1:kickoff',
        turnSeq: 1,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'Started a task in Backend.' }],
        payload: { purpose: 'progress', kickoff: true },
      }),
    });

    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator: { kind: 'user', userId: 'user-1' },
        workflow: 'standard',
        surface: 'web',
        trigger: 'manual',
        task: expect.objectContaining({
          harness: 'opencode-server',
          payload: expect.objectContaining({
            repo: 'acme/api',
            branch: 'main',
            environmentId: 'env-1',
            description: 'Fix the flaky test',
            blank: false,
            launchIdempotencyKey: 'pinned-launch:launch-1',
            reportConsumer: 'orchestrator',
            fastAgentSessionId: 'fast-1',
            fastAgentParent: {
              sessionId: 'fast-1',
              conversation: {
                surface: 'web',
                workspaceId: 'user-1',
                conversationId: 'conv-1',
              },
            },
          }),
        }),
      }),
      expect.objectContaining({ beforeEnqueue: expect.any(Function) }),
    );
  });

  it('launches inside an existing Fast conversation and skips the request row for a blank workspace', async () => {
    mocks.findById.mockResolvedValue({
      id: 'fast-parent',
      conversation: {
        surface: 'web',
        workspaceId: 'user-1',
        conversationId: 'conv-parent',
      },
    });

    const result = await launchPinnedFastSessionTask({
      userId: 'user-1',
      fastConversationId: 'fast-parent',
      launchId: 'launch-2',
      prompt: '',
      task: { ...task, payload: { ...task.payload, blank: true } },
      surface: 'api',
      initiator: { kind: 'user', userId: 'user-1' },
      kickoffMessage: 'Opened a workspace in Backend.',
    });

    expect(result.fastConversationId).toBe('fast-parent');
    expect(mocks.getOrCreateFastAgentSession).not.toHaveBeenCalled();
    expect(mocks.upsertFastAgentMessage).toHaveBeenCalledTimes(1);
    expect(mocks.upsertFastAgentMessage.mock.calls[0]?.[0]).toEqual({
      sessionId: 'fast-parent',
      message: expect.objectContaining({
        eventId: 'pinned-launch:launch-2:kickoff',
      }),
    });
    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'api',
        task: expect.objectContaining({
          payload: expect.objectContaining({
            fastAgentSessionId: 'fast-parent',
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it('replays a launch with a reused id into the Session the first attempt created', async () => {
    mocks.taskRunsFindFirst
      .mockResolvedValueOnce({
        payload: {
          launchIdempotencyKey: 'pinned-launch:launch-1',
          fastAgentParent: {
            sessionId: '66666666-6666-4666-8666-666666666666',
            conversation: {
              surface: 'web',
              workspaceId: 'user-1',
              conversationId: 'conv-first',
            },
          },
        },
      })
      .mockResolvedValueOnce({ id: 7 });
    mocks.findById.mockResolvedValue({
      id: '66666666-6666-4666-8666-666666666666',
      conversation: {
        surface: 'web',
        workspaceId: 'user-1',
        conversationId: 'conv-first',
      },
    });

    const result = await launchPinnedFastSessionTask({
      userId: 'user-1',
      launchId: 'launch-1',
      prompt: 'Fix the flaky test',
      task,
      surface: 'api',
      kickoffMessage: 'Started a task.',
    });

    expect(result.fastConversationId).toBe(
      '66666666-6666-4666-8666-666666666666',
    );
    expect(mocks.getOrCreateFastAgentSession).not.toHaveBeenCalled();
    expect(mocks.findById).toHaveBeenCalledWith({
      id: '66666666-6666-4666-8666-666666666666',
    });
    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            launchIdempotencyKey: 'pinned-launch:launch-1',
            fastAgentSessionId: '66666666-6666-4666-8666-666666666666',
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it('rejects a launch into a Fast conversation that does not exist', async () => {
    mocks.findById.mockResolvedValue(null);

    await expect(
      launchPinnedFastSessionTask({
        userId: 'user-1',
        fastConversationId: 'missing',
        launchId: 'launch-3',
        prompt: 'Hello',
        task,
        surface: 'web',
        kickoffMessage: 'Started a task.',
      }),
    ).rejects.toThrow('The Session for this launch could not be found.');
    expect(mocks.enqueueTask).not.toHaveBeenCalled();
  });
});
