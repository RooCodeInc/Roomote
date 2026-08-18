const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  findSession: vi.fn(),
  findInstallation: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  getPending: vi.fn(),
  setPending: vi.fn(),
  buildBlocks: vi.fn(),
  postMessage: vi.fn(),
  updateMessage: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: mocks.findRun },
      slackQuickAnswers: { findFirst: mocks.findSession },
      slackInstallations: { findFirst: mocks.findInstallation },
    },
  },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  taskRuns: { id: 'task_runs.id', taskId: 'task_runs.task_id' },
  slackQuickAnswers: {
    id: 'slack_quick_answers.id',
    slackChannel: 'slack_quick_answers.slack_channel',
    slackThreadTs: 'slack_quick_answers.slack_thread_ts',
  },
  slackInstallations: {
    isActive: 'slack_installations.is_active',
    teamId: 'slack_installations.team_id',
  },
}));

vi.mock('@roomote/redis', () => ({
  acquireRedisLock: mocks.acquireLock,
}));

vi.mock('@roomote/slack', () => ({
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
    mocks.findSession.mockResolvedValue({ id: parent.sessionId });
    mocks.findInstallation.mockResolvedValue({ botAccessToken: 'xoxb-test' });
    mocks.acquireLock.mockResolvedValue(mocks.releaseLock);
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.getPending.mockResolvedValue(null);
    mocks.setPending.mockResolvedValue(undefined);
    mocks.buildBlocks.mockReturnValue([{ type: 'section' }]);
    mocks.postMessage.mockResolvedValue('101.001');
    mocks.updateMessage.mockResolvedValue(true);
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
