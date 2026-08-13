const {
  dbUpdateSetMock,
  enqueueTaskMock,
  dbUpdateWhereMock,
  consoleWarnMock,
  findActiveSlackTaskRunMock,
  queueSlackMessageMock,
  resolveSlackReactionNamesMock,
} = vi.hoisted(() => ({
  dbUpdateSetMock: vi.fn(),
  enqueueTaskMock: vi.fn(),
  dbUpdateWhereMock: vi.fn(),
  consoleWarnMock: vi.fn(),
  findActiveSlackTaskRunMock: vi.fn(),
  queueSlackMessageMock: vi.fn(),
  resolveSlackReactionNamesMock: vi.fn(),
}));

vi.mock('@roomote/cloud-agents', () => ({
  getSlackThreadDisplayName: vi.fn(
    (message: { user?: string; username?: string }) =>
      message.username?.trim() || message.user || 'user',
  ),
  wrapSlackMessage: vi.fn((text: string) => text),
  wrapSlackReplyingTo: vi.fn((message: { text: string }) => message.text),
  wrapSlackThreadContext: vi.fn((messages: { text: string }[]) =>
    messages.map((message) => message.text).join('\n'),
  ),
  wrapSlackTurnPolicy: vi.fn(() => ''),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: enqueueTaskMock,
}));

vi.mock('@roomote/db/server', () => ({
  taskRuns: { id: 'id', payload: 'payload' },
  db: {
    update: vi.fn(() => ({
      set: dbUpdateSetMock.mockImplementation(() => ({
        where: dbUpdateWhereMock,
      })),
    })),
  },
  eq: vi.fn(),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  })),
}));

vi.mock('../find-active-slack-task-run', () => ({
  findActiveSlackTaskRun: findActiveSlackTaskRunMock,
}));

vi.mock('../emoji-preferences', () => ({
  resolveSlackReactionNames: resolveSlackReactionNamesMock,
}));

vi.mock('../slack-messages', () => ({
  queueSlackMessage: queueSlackMessageMock,
}));

describe('startSlackAppMentionTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(consoleWarnMock);
    enqueueTaskMock.mockResolvedValue({ id: 42, taskId: 'task_123' });
    dbUpdateSetMock.mockClear();
    dbUpdateWhereMock.mockResolvedValue(undefined);
    findActiveSlackTaskRunMock.mockResolvedValue(null);
    queueSlackMessageMock.mockResolvedValue(undefined);
    resolveSlackReactionNamesMock.mockResolvedValue({
      ackEmoji: 'eyes',
      completionEmoji: 'white_check_mark',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists an exact Slack conversation permalink when provided', async () => {
    const { startSlackAppMentionTask } =
      await import('../start-slack-app-mention');

    await startSlackAppMentionTask({
      initiator: { kind: 'user', userId: 'user_123' },
      trigger: 'message',
      channel: 'C123',
      teamId: 'T123',
      slackUserId: 'U123',
      text: 'hello',
      ts: '111.000',
      threadTs: '111.000',
      repo: 'owner/repo',
      slackConversationUrl:
        ' https://acme-team.slack.com/archives/C123/p111000?thread_ts=111.000&cid=C123 ',
    });

    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator: { kind: 'user', userId: 'user_123' },
        workflow: 'standard',
        surface: 'slack',
        trigger: 'message',
        channels: {
          slackChannelId: 'C123',
          slackThreadTs: '111.000',
        },
        task: expect.objectContaining({
          payload: expect.objectContaining({
            slackConversationUrl:
              'https://acme-team.slack.com/archives/C123/p111000?thread_ts=111.000&cid=C123',
          }),
        }),
      }),
      {},
    );
  });

  it('persists an exact Slack conversation permalink onto a reused active task run', async () => {
    findActiveSlackTaskRunMock.mockResolvedValueOnce({
      id: 99,
      taskId: 'task_existing',
      payload: {
        channel: 'C123',
        text: 'earlier text',
        thread_ts: '111.000',
      },
    });
    const { startSlackAppMentionTask } =
      await import('../start-slack-app-mention');

    await startSlackAppMentionTask({
      initiator: { kind: 'user', userId: 'user_123' },
      trigger: 'message',
      channel: 'C123',
      teamId: 'T123',
      slackUserId: 'U123',
      text: 'hello again',
      ts: '111.000',
      threadTs: '111.000',
      repo: 'owner/repo',
      slackConversationUrl:
        'https://acme-team.slack.com/archives/C123/p111000?thread_ts=111.000&cid=C123',
    });

    expect(findActiveSlackTaskRunMock).toHaveBeenCalledWith('111.000', {
      slackTeamId: 'T123',
    });
    expect(dbUpdateSetMock).toHaveBeenCalledWith({
      payload: expect.objectContaining({
        values: expect.arrayContaining([
          JSON.stringify({
            slackConversationUrl:
              'https://acme-team.slack.com/archives/C123/p111000?thread_ts=111.000&cid=C123',
          }),
        ]),
      }),
    });
    expect(dbUpdateWhereMock).toHaveBeenCalledTimes(1);
    expect(queueSlackMessageMock).toHaveBeenCalledWith(
      99,
      expect.objectContaining({
        text: 'hello again',
      }),
    );
  });

  it('does not rewrite the reused job payload when the permalink is unchanged', async () => {
    findActiveSlackTaskRunMock.mockResolvedValueOnce({
      id: 99,
      taskId: 'task_existing',
      payload: {
        channel: 'C123',
        text: 'earlier text',
        thread_ts: '111.000',
        slackConversationUrl:
          'https://acme-team.slack.com/archives/C123/p111000?thread_ts=111.000&cid=C123',
      },
    });
    const { startSlackAppMentionTask } =
      await import('../start-slack-app-mention');

    await startSlackAppMentionTask({
      initiator: { kind: 'user', userId: 'user_123' },
      trigger: 'message',
      channel: 'C123',
      teamId: 'T123',
      slackUserId: 'U123',
      text: 'hello again',
      ts: '111.000',
      threadTs: '111.000',
      repo: 'owner/repo',
      slackConversationUrl:
        'https://acme-team.slack.com/archives/C123/p111000?thread_ts=111.000&cid=C123',
    });

    expect(dbUpdateSetMock).not.toHaveBeenCalled();
    expect(queueSlackMessageMock).toHaveBeenCalledWith(
      99,
      expect.objectContaining({
        text: 'hello again',
      }),
    );
  });
});
