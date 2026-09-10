const mocks = vi.hoisted(() => ({
  findSourceRun: vi.fn(),
  getTaskUrl: vi.fn(),
  launchTask: vi.fn(),
  processAttachments: vi.fn(),
  reply: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  getTaskUrl: mocks.getTaskUrl,
}));

vi.mock('@roomote/sdk/server/communication', () => ({
  findCommunicationTaskRunBySourceEvent: mocks.findSourceRun,
}));

vi.mock('../replies.js', () => ({ replyToDiscordEvent: mocks.reply }));

vi.mock('../task-launch.js', () => ({
  launchDiscordTask: mocks.launchTask,
}));

vi.mock('../attachments.js', () => ({
  processDiscordAttachments: mocks.processAttachments,
}));

vi.mock('../thread-delivery.js', () => ({
  markDiscordThreadMessagesDelivered: vi.fn().mockResolvedValue(undefined),
  claimUndeliveredDiscordThreadMessages: vi.fn(
    async (_channelId: string, ids: string[]) => ids,
  ),
  releaseClaimedDiscordThreadMessages: vi.fn().mockResolvedValue(undefined),
}));

import { startNewDiscordTask } from '../task-orchestration.js';

const WORKSPACE = {
  environmentId: 'env-1',
  repoForPayload: 'acme/repo',
  workspaceDisplayName: 'Acme',
};

describe('startNewDiscordTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTaskUrl.mockReturnValue('https://roomote.example/task/task-1');
    mocks.reply.mockResolvedValue({ messageId: 'reply-1' });
    mocks.findSourceRun.mockResolvedValue(null);
    mocks.launchTask.mockResolvedValue({
      launchResult: { id: 9, taskId: 'task-1' },
      taskUrl: 'https://roomote.example/task/task-1',
      createdThread: null,
    });
    mocks.processAttachments.mockResolvedValue({
      images: [],
      attachmentTexts: [],
      warnings: [],
    });
  });

  it('forwards a Fast kickoff gate to the Discord launcher', async () => {
    const beforeEnqueueKickoff = vi.fn().mockResolvedValue(undefined);

    const result = await startNewDiscordTask({
      provider: {} as never,
      applicationId: 'application-1',
      requesterDiscordUserId: 'discord-user-1',
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix checkout',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-fast-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'dm-1',
        communicationMessageId: 'message-fast-1',
      },
      channel: {
        channelId: 'dm-1',
        channelName: 'Direct message',
        channelType: 1,
        isDirectMessage: true,
        isThread: false,
      },
      workspace: {
        repoForPayload: 'acme/repo',
        workspaceDisplayName: 'Acme',
      },
      beforeEnqueueKickoff,
    });

    expect(result.status).toBe('started');
    expect(mocks.launchTask).toHaveBeenCalledWith(
      expect.objectContaining({ beforeEnqueueKickoff }),
    );
  });

  it('does not route or launch a second task for a retried source event', async () => {
    mocks.findSourceRun.mockResolvedValue({
      id: 41,
      taskId: 'task-1',
      status: 'running',
      payload: {
        communicationProvider: 'discord',
        communicationSourceEventId: 'message-1',
      },
    });

    const result = await startNewDiscordTask({
      provider: {} as never,
      applicationId: 'application-1',
      requesterDiscordUserId: 'discord-user-1',
      workspace: WORKSPACE,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix the flaky test',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-1',
        communicationMessageId: 'message-1',
      },
      channel: {
        channelId: 'channel-1',
        channelName: 'general',
        channelType: 0,
        guildId: 'guild-1',
        isDirectMessage: false,
        isThread: false,
      },
    });

    expect(result.status).toBe('already_started');
    expect(mocks.launchTask).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('already started'),
      }),
    );
  });

  it('leaves retried Fast source acknowledgement to the model-owned kickoff', async () => {
    mocks.findSourceRun.mockResolvedValue({
      id: 41,
      taskId: 'task-1',
      status: 'running',
      payload: {
        communicationProvider: 'discord',
        communicationSourceEventId: 'message-fast-1',
      },
    });

    const result = await startNewDiscordTask({
      provider: {} as never,
      applicationId: 'application-1',
      requesterDiscordUserId: 'discord-user-1',
      workspace: WORKSPACE,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Fix checkout',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-fast-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'dm-1',
        communicationMessageId: 'message-fast-1',
      },
      channel: {
        channelId: 'dm-1',
        channelName: 'Direct message',
        channelType: 1,
        isDirectMessage: true,
        isThread: false,
      },
      beforeEnqueueKickoff: vi.fn(),
    });

    expect(result.status).toBe('already_started');
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(mocks.launchTask).not.toHaveBeenCalled();
  });

  it('clears intake eyes when a retried source event already started a task', async () => {
    mocks.findSourceRun.mockResolvedValue({
      id: 41,
      taskId: 'task-1',
      status: 'running',
      payload: {
        communicationProvider: 'discord',
        communicationSourceEventId: 'message-1',
      },
    });
    const removeReaction = vi.fn().mockResolvedValue(undefined);

    await startNewDiscordTask({
      provider: { removeReaction } as never,
      applicationId: 'application-1',
      requesterDiscordUserId: 'discord-user-1',
      workspace: WORKSPACE,
      launchOwnerUserId: 'user-1',
      intakeAckPinned: true,
      queuedMessage: {
        provider: 'discord',
        text: 'Fix the flaky test',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-1',
        communicationMessageId: 'message-1',
        communicationAnchorMessageId: 'message-1',
      },
      channel: {
        channelId: 'channel-1',
        channelName: 'general',
        channelType: 0,
        guildId: 'guild-1',
        isDirectMessage: false,
        isThread: false,
      },
    });

    expect(removeReaction).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: 'message-1',
      name: 'eyes',
    });
  });

  it('launches in-thread with full history and attachment context (Slack parity)', async () => {
    const provider = {
      fetchChannelMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: '100',
            user: 'u-alice',
            username: 'Alice',
            text: 'Deploy failed on main',
            files: [
              {
                id: 'att-1',
                name: 'log.txt',
                mimeType: 'text/plain',
                size: 12,
                url: 'https://cdn.discordapp.com/attachments/log.txt',
              },
            ],
          },
          {
            id: '200',
            user: 'u-matt',
            username: 'Matt',
            text: '@Roomote investigate the flaky build',
          },
        ],
      }),
      // The message this thread was started from lives in the parent channel
      // (its id equals the thread id) and is absent from the thread listing.
      fetchMessage: vi.fn().mockResolvedValue({
        provider: 'discord',
        id: '50',
        user: 'u-sky',
        username: 'Sky',
        text: 'Tested the PR and the task failed while preparing the workspace.',
        channelId: 'channel-1',
        fileCount: 0,
      }),
    };
    mocks.processAttachments.mockResolvedValue({
      images: ['data:image/png;base64,thread'],
      attachmentTexts: ['log.txt contents'],
      warnings: [],
    });

    const result = await startNewDiscordTask({
      provider: provider as never,
      applicationId: 'application-1',
      requesterDiscordUserId: 'discord-user-1',
      workspace: WORKSPACE,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'investigate the flaky build',
        user: 'Matt',
        userId: 'user-1',
        ts: '200',
        images: ['data:image/png;base64,current'],
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-1',
        communicationThreadId: '50',
        communicationMessageId: '200',
      },
      channel: {
        channelId: '50',
        channelName: 'General discussion',
        channelType: 11,
        guildId: 'guild-1',
        parentChannelId: 'channel-1',
        isDirectMessage: false,
        isThread: true,
      },
      forceNewThread: false,
    });

    expect(result.status).toBe('started');
    expect(provider.fetchChannelMessages).toHaveBeenCalledWith({
      channelId: '50',
    });
    expect(provider.fetchMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: '50',
    });
    expect(mocks.processAttachments).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'att-1',
        filename: 'log.txt',
        url: 'https://cdn.discordapp.com/attachments/log.txt',
      }),
    ]);
    const threadLaunch = mocks.launchTask.mock.calls[0]?.[0] as {
      agentPromptText?: string;
      queuedMessage: { images?: string[] };
    };
    expect(threadLaunch.agentPromptText).toContain('log.txt contents');
    expect(threadLaunch.agentPromptText).toContain('Deploy failed on main');
    expect(threadLaunch.queuedMessage.images).toContain(
      'data:image/png;base64,thread',
    );
    expect(mocks.launchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        forceNewThread: false,
        agentPromptText: expect.stringContaining('<thread_context>'),
        queuedMessage: expect.objectContaining({
          images: [
            'data:image/png;base64,current',
            'data:image/png;base64,thread',
          ],
        }),
      }),
    );
    const agentPrompt = mocks.launchTask.mock.calls[0]?.[0]
      .agentPromptText as string;
    expect(agentPrompt).toContain(
      'Sky: Tested the PR and the task failed while preparing the workspace.',
    );
    expect(agentPrompt).toContain('Alice: Deploy failed on main');
    expect(agentPrompt).toContain('investigate the flaky build');
    expect(agentPrompt).toContain('log.txt contents');
    expect(agentPrompt).not.toContain('@Roomote investigate the flaky build');
  });

  it('excludes attachments posted after a reacted-to message', async () => {
    const file = (id: string) => ({
      id,
      name: `${id}.txt`,
      mimeType: 'text/plain',
      size: 12,
      url: `https://cdn.discordapp.com/attachments/${id}.txt`,
    });
    const provider = {
      fetchChannelMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: '100',
            user: 'u-alice',
            username: 'Alice',
            text: 'Earlier context',
            files: [file('before')],
          },
          {
            id: '200',
            user: 'u-alice',
            username: 'Alice',
            text: 'React to this',
            files: [file('target')],
          },
          {
            id: '300',
            user: 'u-bob',
            username: 'Bob',
            text: 'Later context',
            files: [file('after')],
          },
        ],
      }),
    };

    await startNewDiscordTask({
      provider: provider as never,
      applicationId: 'application-1',
      requesterDiscordUserId: 'discord-user-1',
      workspace: WORKSPACE,
      launchOwnerUserId: 'user-1',
      contextThroughMessageId: '200',
      queuedMessage: {
        provider: 'discord',
        text: 'Act on this',
        user: 'Matt',
        userId: 'user-1',
        ts: 'channel-1:200:discord-user-1:white_check_mark:42',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-1',
        communicationThreadId: 'thread-1',
        communicationMessageId: '200',
      },
      channel: {
        channelId: 'thread-1',
        channelName: 'Task thread',
        channelType: 11,
        guildId: 'guild-1',
        parentChannelId: 'channel-1',
        isDirectMessage: false,
        isThread: true,
      },
    });

    expect(mocks.processAttachments).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'before' }),
      expect.objectContaining({ id: 'target' }),
    ]);
    expect(mocks.processAttachments).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'after' })]),
    );
  });

  it('does not inherit prior thread context for /new (forceNewThread)', async () => {
    const provider = {
      fetchChannelMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: '100',
            user: 'u-alice',
            username: 'Alice',
            text: 'Should not leak into the fresh task',
            files: [
              {
                id: 'att-1',
                name: 'old.txt',
                mimeType: 'text/plain',
                size: 12,
                url: 'https://cdn.discordapp.com/attachments/old.txt',
              },
            ],
          },
        ],
      }),
    };

    const result = await startNewDiscordTask({
      provider: provider as never,
      applicationId: 'application-1',
      requesterDiscordUserId: 'discord-user-1',
      workspace: WORKSPACE,
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'Start something unrelated',
        user: 'Matt',
        userId: 'user-1',
        ts: 'interaction-1',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-1',
        communicationThreadId: 'old-thread',
        communicationMessageId: 'interaction-1',
      },
      channel: {
        channelId: 'old-thread',
        channelName: 'Old task',
        channelType: 11,
        guildId: 'guild-1',
        parentChannelId: 'channel-1',
        isDirectMessage: false,
        isThread: true,
      },
      forceNewThread: true,
    });

    expect(result.status).toBe('started');
    expect(provider.fetchChannelMessages).not.toHaveBeenCalled();
    expect(mocks.processAttachments).not.toHaveBeenCalled();
    expect(mocks.launchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        forceNewThread: true,
        queuedMessage: expect.objectContaining({
          text: 'Start something unrelated',
        }),
      }),
    );
    const launchArgs = mocks.launchTask.mock.calls[0]?.[0] as {
      agentPromptText?: string;
    };
    expect(launchArgs.agentPromptText).toBeUndefined();
  });

  it('includes the explicit replied-to channel message without dumping full channel history', async () => {
    const provider = {
      fetchChannelMessages: vi.fn(),
      fetchMessage: vi.fn().mockResolvedValue({
        provider: 'discord',
        id: '100',
        user: 'u-alice',
        username: 'Alice',
        text: 'pnpm build triggers codebase indexing with hundreds of temporary files',
        channelId: 'channel-1',
        fileCount: 0,
      }),
    };

    const result = await startNewDiscordTask({
      provider: provider as never,
      applicationId: 'application-1',
      requesterDiscordUserId: 'discord-user-1',
      workspace: WORKSPACE,
      launchOwnerUserId: 'user-1',
      replyToMessageId: '100',
      replyToChannelId: 'channel-1',
      queuedMessage: {
        provider: 'discord',
        text: 'can you check if this issue already exists?',
        user: 'Toray',
        userId: 'user-1',
        ts: '200',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-1',
        communicationMessageId: '200',
        communicationAnchorMessageId: '200',
      },
      channel: {
        channelId: 'channel-1',
        channelName: 'general',
        channelType: 0,
        guildId: 'guild-1',
        isDirectMessage: false,
        isThread: false,
      },
    });

    expect(result.status).toBe('started');
    expect(provider.fetchChannelMessages).not.toHaveBeenCalled();
    expect(provider.fetchMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: '100',
    });
    const agentPrompt = mocks.launchTask.mock.calls[0]?.[0]
      .agentPromptText as string;
    expect(agentPrompt).toContain(
      '<thread_context>\nAlice: pnpm build triggers codebase indexing with hundreds of temporary files\n</thread_context>',
    );
    expect(agentPrompt).toContain(
      'can you check if this issue already exists?',
    );
  });

  it.each([
    {
      name: 'the source event lookup fails',
      setup: () =>
        mocks.findSourceRun.mockRejectedValue(new Error('lookup failed')),
    },
    {
      name: 'the launch fails',
      setup: () =>
        mocks.launchTask.mockRejectedValue(new Error('launch failed')),
    },
  ])('clears intake eyes when $name', async ({ setup }) => {
    setup();
    const removeReaction = vi.fn().mockResolvedValue(undefined);

    await expect(
      startNewDiscordTask({
        provider: { removeReaction } as never,
        applicationId: 'application-1',
        requesterDiscordUserId: 'discord-user-1',
        workspace: WORKSPACE,
        launchOwnerUserId: 'user-1',
        intakeAckPinned: true,
        queuedMessage: {
          provider: 'discord',
          text: 'Fix the flaky test',
          user: 'Matt',
          userId: 'user-1',
          ts: 'message-1',
        },
        metadata: {
          communicationProvider: 'discord',
          communicationChannelId: 'channel-1',
          communicationMessageId: 'message-1',
          communicationAnchorMessageId: 'message-1',
        },
        channel: {
          channelId: 'channel-1',
          channelName: 'general',
          channelType: 0,
          guildId: 'guild-1',
          isDirectMessage: false,
          isThread: false,
        },
      }),
    ).rejects.toThrow();

    expect(removeReaction).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: 'message-1',
      name: 'eyes',
    });
  });
});
