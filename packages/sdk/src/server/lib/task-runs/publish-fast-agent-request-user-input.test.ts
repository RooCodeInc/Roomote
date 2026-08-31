const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  findSession: vi.fn(),
  bindSession: vi.fn(),
  findInstallation: vi.fn(),
  findCustomAutomation: vi.fn(),
  acquireRootBindingLock: vi.fn(),
  releaseRootBindingLock: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  getPending: vi.fn(),
  setPending: vi.fn(),
  buildBlocks: vi.fn(),
  postMessage: vi.fn(),
  updateMessage: vi.fn(),
  getTaskUrl: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: mocks.findRun },
      slackInstallations: { findFirst: mocks.findInstallation },
    },
  },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  getCustomAutomationById: mocks.findCustomAutomation,
  taskRuns: { id: 'task_runs.id', taskId: 'task_runs.task_id' },
  slackInstallations: {
    isActive: 'slack_installations.is_active',
    teamId: 'slack_installations.team_id',
  },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  fastAgentConversationRepository: {
    findById: mocks.findSession,
    getOrCreate: mocks.bindSession,
  },
  getTaskUrl: mocks.getTaskUrl,
}));

vi.mock('@roomote/redis', () => ({
  acquireRedisLock: mocks.acquireLock,
}));

vi.mock('@roomote/slack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/slack')>()),
  acquireSlackFastRootBindingLock: mocks.acquireRootBindingLock,
  buildSlackRequestUserInputBlocks: mocks.buildBlocks,
  getPendingSlackRequestUserInput: mocks.getPending,
  setPendingSlackRequestUserInput: mocks.setPending,
  SlackNotifier: class SlackNotifier {
    postMessage = mocks.postMessage;
    updateMessage = mocks.updateMessage;
  },
}));

import { publishFastAgentRequestUserInput } from './publish-fast-agent-request-user-input';

const parent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  conversation: {
    surface: 'slack' as const,
    workspaceId: 'T123',
    conversationId: '100.001',
    replyTarget: { channelId: 'C123', threadId: '100.001' },
  },
};

const input = {
  runId: 42,
  taskId: 'task-1',
  requestId: 'request-1',
  questions: [
    {
      id: 'animal',
      header: 'Animal',
      question: 'Which animal?',
      isOther: false,
      isSecret: false,
      options: [{ label: 'Hedgehog', description: 'Use the surprise animal.' }],
    },
  ],
};

describe('publishFastAgentRequestUserInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findRun.mockResolvedValue({
      id: 42,
      taskId: 'task-1',
      payload: { fastAgentParent: parent },
    });
    mocks.findSession.mockResolvedValue({
      id: parent.sessionId,
      userId: 'u1',
      conversation: parent.conversation,
      messages: [],
    });
    mocks.findInstallation.mockResolvedValue({ botAccessToken: 'xoxb-test' });
    mocks.findCustomAutomation.mockResolvedValue({
      id: 'automation-1',
      name: 'Weekly scan',
    });
    mocks.acquireRootBindingLock.mockResolvedValue(
      mocks.releaseRootBindingLock,
    );
    mocks.releaseRootBindingLock.mockResolvedValue(undefined);
    mocks.bindSession.mockResolvedValue(undefined);
    mocks.acquireLock.mockResolvedValue(mocks.releaseLock);
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.getPending.mockResolvedValue(null);
    mocks.setPending.mockResolvedValue(undefined);
    mocks.buildBlocks.mockReturnValue([{ type: 'section' }]);
    mocks.postMessage.mockResolvedValue('101.001');
    mocks.updateMessage.mockResolvedValue(true);
    mocks.getTaskUrl.mockReturnValue('https://roomote.example/task/task-1');
  });

  it('posts one native prompt in the parent thread and records its timestamp', async () => {
    await expect(publishFastAgentRequestUserInput(input)).resolves.toEqual({
      published: true,
      messageTs: '101.001',
    });

    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '100.001',
        blocks: [{ type: 'section' }],
        client_msg_id: expect.any(String),
      }),
    );
    expect(mocks.setPending).toHaveBeenLastCalledWith(
      '100.001',
      expect.objectContaining({
        requestId: 'request-1',
        runId: 42,
        promptMessageTs: '101.001',
      }),
    );
    expect(mocks.releaseLock).toHaveBeenCalledOnce();
  });

  it('updates the existing prompt when the same request gains richer questions', async () => {
    mocks.getPending.mockResolvedValueOnce({
      requestId: 'request-1',
      runId: 42,
      taskId: 'task-1',
      questions: [],
      status: 'pending',
      currentQuestionIndex: 0,
      answers: {},
      createdAt: 123,
      promptMessageTs: '101.001',
    });

    await expect(publishFastAgentRequestUserInput(input)).resolves.toEqual({
      published: true,
      messageTs: '101.001',
    });

    expect(mocks.updateMessage).toHaveBeenCalledWith({
      channel: 'C123',
      ts: '101.001',
      message: { blocks: [{ type: 'section' }] },
    });
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it('creates and binds a meaningful root before pending automation input', async () => {
    const pendingConversation = {
      ...parent.conversation,
      conversationId: 'automation-1:occurrence-1',
      replyTarget: { channelId: 'C123' },
    };
    mocks.findRun.mockResolvedValue({
      id: 42,
      taskId: 'task-1',
      payload: {
        fastAgentParent: {
          ...parent,
          conversation: pendingConversation,
        },
        customAutomationId: 'automation-1',
      },
    });
    mocks.findSession.mockResolvedValue({
      id: parent.sessionId,
      userId: 'u1',
      conversation: pendingConversation,
      messages: [],
    });
    mocks.postMessage
      .mockResolvedValueOnce('100.001')
      .mockResolvedValueOnce('101.001');

    await expect(publishFastAgentRequestUserInput(input)).resolves.toEqual({
      published: true,
      messageTs: '101.001',
    });

    expect(mocks.postMessage.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        channel: 'C123',
        text: 'Weekly scan needs input to continue.',
        blocks: expect.arrayContaining([
          { type: 'markdown', text: 'Weekly scan needs input to continue.' },
          expect.objectContaining({
            type: 'actions',
            elements: expect.arrayContaining([
              expect.objectContaining({
                action_id: 'late_bound_automation_view_session',
                url: expect.stringContaining(`/sessions/${parent.sessionId}`),
              }),
            ]),
          }),
        ]),
      }),
    );
    expect(mocks.bindSession).toHaveBeenCalledWith({
      userId: 'u1',
      conversation: {
        ...pendingConversation,
        replyTarget: { channelId: 'C123', threadId: '100.001' },
      },
    });
    expect(mocks.postMessage.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '100.001',
        blocks: [{ type: 'section' }],
      }),
    );
    expect(mocks.setPending).toHaveBeenLastCalledWith(
      '100.001',
      expect.objectContaining({ promptMessageTs: '101.001' }),
    );
    expect(
      mocks.acquireRootBindingLock.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.postMessage.mock.invocationCallOrder[0]!);
    expect(mocks.postMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.bindSession.mock.invocationCallOrder[0]!,
    );
    expect(mocks.bindSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.releaseRootBindingLock.mock.invocationCallOrder[0]!,
    );
  });

  it('reuses a root bound by a concurrent closeout while waiting for the lock', async () => {
    const pendingConversation = {
      ...parent.conversation,
      conversationId: 'automation-1:occurrence-1',
      replyTarget: { channelId: 'C123' },
    };
    const pendingSession = {
      id: parent.sessionId,
      userId: 'u1',
      conversation: pendingConversation,
      messages: [],
    };
    mocks.findRun.mockResolvedValue({
      id: 42,
      taskId: 'task-1',
      payload: {
        fastAgentParent: {
          ...parent,
          conversation: pendingConversation,
        },
        customAutomationId: 'automation-1',
      },
    });
    mocks.findSession
      .mockResolvedValueOnce(pendingSession)
      .mockResolvedValueOnce({
        ...pendingSession,
        conversation: {
          ...pendingConversation,
          replyTarget: { channelId: 'C123', threadId: '100.001' },
        },
      });
    mocks.postMessage.mockResolvedValueOnce('101.001');

    await expect(publishFastAgentRequestUserInput(input)).resolves.toEqual({
      published: true,
      messageTs: '101.001',
    });

    expect(mocks.postMessage).toHaveBeenCalledOnce();
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '100.001',
        blocks: [{ type: 'section' }],
      }),
    );
    expect(
      mocks.acquireRootBindingLock.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.findSession.mock.invocationCallOrder[1]!);
    expect(mocks.bindSession).not.toHaveBeenCalled();
  });

  it('preserves a different outstanding request instead of replacing it', async () => {
    mocks.getPending.mockResolvedValueOnce({
      requestId: 'request-other',
      promptMessageTs: '102.001',
    });

    await expect(publishFastAgentRequestUserInput(input)).resolves.toEqual({
      published: false,
      messageTs: '102.001',
    });
    expect(mocks.setPending).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });
});
