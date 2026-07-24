const mocks = vi.hoisted(() => ({
  buildRoutingContext: vi.fn(),
  findSourceRun: vi.fn(),
  getTaskUrl: vi.fn(),
  launchTask: vi.fn(),
  processAttachments: vi.fn(),
  reply: vi.fn(),
  requestConfirmation: vi.fn(),
  resolveWorkspace: vi.fn(),
  routeTask: vi.fn(),
  shouldAutoConfirm: vi.fn(),
  findInstallation: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildDiscordRoutingContext: mocks.buildRoutingContext,
  getTaskUrl: mocks.getTaskUrl,
  routeTask: mocks.routeTask,
}));

vi.mock('@roomote/sdk/server', () => ({
  findDiscordInstallationByGuildId: mocks.findInstallation,
}));

vi.mock('@roomote/sdk/server/communication', () => ({
  findCommunicationTaskRunBySourceEvent: mocks.findSourceRun,
}));

vi.mock('../replies.js', () => ({ replyToDiscordEvent: mocks.reply }));

vi.mock('../routing-confirmation.js', () => ({
  requestDiscordRoutingConfirmation: mocks.requestConfirmation,
  shouldAutoConfirmDiscordRoute: mocks.shouldAutoConfirm,
}));

vi.mock('../task-launch.js', () => ({
  launchDiscordTask: mocks.launchTask,
  resolveDiscordWorkspace: mocks.resolveWorkspace,
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

describe('startNewDiscordTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTaskUrl.mockReturnValue('https://roomote.example/task/task-1');
    mocks.reply.mockResolvedValue({ messageId: 'reply-1' });
    mocks.findSourceRun.mockResolvedValue(null);
    mocks.findInstallation.mockResolvedValue(null);
    mocks.shouldAutoConfirm.mockReturnValue(true);
    mocks.buildRoutingContext.mockResolvedValue({ source: 'discord' });
    mocks.routeTask.mockResolvedValue({
      status: 'routed',
      result: {
        workspace: { type: 'environment', id: 'env-1' },
        kickoffMessage: 'On it.',
      },
    });
    mocks.resolveWorkspace.mockResolvedValue({
      environmentId: 'env-1',
      repoForPayload: 'acme/repo',
      workspaceDisplayName: 'Acme',
    });
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
    expect(mocks.buildRoutingContext).not.toHaveBeenCalled();
    expect(mocks.routeTask).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('already started'),
      }),
    );
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
    expect(mocks.buildRoutingContext).toHaveBeenCalledWith(
      expect.objectContaining({
        taskDescription: expect.stringContaining('log.txt contents'),
        threadMessages: [
          {
            user: 'Sky',
            text: 'Tested the PR and the task failed while preparing the workspace.',
          },
          { user: 'Alice', text: 'Deploy failed on main' },
          { user: 'Matt', text: '@Roomote investigate the flaky build' },
        ],
        images: [
          'data:image/png;base64,current',
          'data:image/png;base64,thread',
        ],
      }),
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
    expect(mocks.buildRoutingContext).toHaveBeenCalledWith(
      expect.objectContaining({
        taskDescription: 'Start something unrelated',
        threadMessages: [{ user: 'Matt', text: 'Start something unrelated' }],
      }),
    );
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
    expect(mocks.buildRoutingContext).toHaveBeenCalledWith(
      expect.objectContaining({
        threadMessages: [
          {
            user: 'Alice',
            text: 'pnpm build triggers codebase indexing with hundreds of temporary files',
          },
          {
            user: 'Toray',
            text: 'can you check if this issue already exists?',
          },
        ],
      }),
    );
    const agentPrompt = mocks.launchTask.mock.calls[0]?.[0]
      .agentPromptText as string;
    expect(agentPrompt).toContain(
      '<thread_context>\nAlice: pnpm build triggers codebase indexing with hundreds of temporary files\n</thread_context>',
    );
    expect(agentPrompt).toContain(
      'can you check if this issue already exists?',
    );
  });

  it('stores thread context on routing confirmation for later launch', async () => {
    mocks.shouldAutoConfirm.mockReturnValue(false);
    mocks.requestConfirmation.mockResolvedValue({
      pendingRouteId: 'pending-1',
    });
    const provider = {
      fetchChannelMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: '100',
            user: 'u-alice',
            username: 'Alice',
            text: 'Earlier detail',
          },
          {
            id: '200',
            user: 'u-matt',
            username: 'Matt',
            text: 'please fix it',
          },
        ],
      }),
    };

    const result = await startNewDiscordTask({
      provider: provider as never,
      applicationId: 'application-1',
      requesterDiscordUserId: 'discord-user-1',
      launchOwnerUserId: 'user-1',
      queuedMessage: {
        provider: 'discord',
        text: 'please fix it',
        user: 'Matt',
        userId: 'user-1',
        ts: '200',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-1',
        communicationThreadId: 'discussion-thread',
        communicationMessageId: '200',
      },
      channel: {
        channelId: 'discussion-thread',
        channelName: 'General discussion',
        channelType: 11,
        guildId: 'guild-1',
        parentChannelId: 'channel-1',
        isDirectMessage: false,
        isThread: true,
      },
    });

    expect(result.status).toBe('confirmation_pending');
    expect(mocks.requestConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPromptText: expect.stringContaining('Alice: Earlier detail'),
      }),
    );
  });

  it('clears intake eyes when a platform answer is handled inline', async () => {
    mocks.routeTask.mockResolvedValue({
      status: 'platform_answer',
      result: { answer: 'Use the npm scripts in package.json.' },
    });
    const removeReaction = vi.fn().mockResolvedValue(undefined);

    const result = await startNewDiscordTask({
      provider: { removeReaction } as never,
      applicationId: 'application-1',
      requesterDiscordUserId: 'discord-user-1',
      launchOwnerUserId: 'user-1',
      intakeAckPinned: true,
      queuedMessage: {
        provider: 'discord',
        text: 'How do I run tests?',
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

    expect(result.status).toBe('replied_inline');
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Use the npm scripts in package.json.',
      }),
    );
    expect(mocks.launchTask).not.toHaveBeenCalled();
    expect(removeReaction).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: 'message-1',
      name: 'eyes',
    });
  });

  it('clears intake eyes when auto-start skips a platform answer', async () => {
    mocks.routeTask.mockResolvedValue({
      status: 'platform_answer',
      result: { answer: 'Should not post in monitored channel.' },
    });
    const removeReaction = vi.fn().mockResolvedValue(undefined);

    const result = await startNewDiscordTask({
      provider: { removeReaction } as never,
      applicationId: 'application-1',
      requesterDiscordUserId: 'discord-user-1',
      launchOwnerUserId: 'user-1',
      intakeAckPinned: true,
      channelAutoStart: {
        initiator: { kind: 'user', userId: 'user-1' },
      },
      queuedMessage: {
        provider: 'discord',
        text: 'what is 2+2?',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-2',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-2',
        communicationMessageId: 'message-2',
        communicationAnchorMessageId: 'message-2',
      },
      channel: {
        channelId: 'channel-2',
        channelName: 'bugs',
        channelType: 0,
        guildId: 'guild-1',
        isDirectMessage: false,
        isThread: false,
      },
    });

    expect(result.status).toBe('skipped_platform_answer');
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(removeReaction).toHaveBeenCalledWith({
      channelId: 'channel-2',
      messageId: 'message-2',
      name: 'eyes',
    });
  });

  it('does not remove eyes when intake ack was never pinned', async () => {
    mocks.routeTask.mockResolvedValue({
      status: 'platform_answer',
      result: { answer: 'No eyes were pinned.' },
    });
    const removeReaction = vi.fn().mockResolvedValue(undefined);

    const result = await startNewDiscordTask({
      provider: { removeReaction } as never,
      applicationId: 'application-1',
      requesterDiscordUserId: 'discord-user-1',
      launchOwnerUserId: 'user-1',
      intakeAckPinned: false,
      queuedMessage: {
        provider: 'discord',
        text: 'How do I run tests?',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-3',
      },
      metadata: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-1',
        communicationMessageId: 'message-3',
        communicationAnchorMessageId: 'message-3',
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

    expect(result.status).toBe('replied_inline');
    expect(removeReaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'the source event lookup fails',
      setup: () =>
        mocks.findSourceRun.mockRejectedValue(new Error('lookup failed')),
    },
    {
      name: 'routing fails',
      setup: () =>
        mocks.routeTask.mockRejectedValue(new Error('routing failed')),
    },
    {
      name: 'routing confirmation fails',
      setup: () => {
        mocks.shouldAutoConfirm.mockReturnValue(false);
        mocks.requestConfirmation.mockRejectedValue(
          new Error('confirmation failed'),
        );
      },
    },
    {
      name: 'the routed workspace is unavailable',
      setup: () => mocks.resolveWorkspace.mockResolvedValue(null),
    },
  ])('clears intake eyes when $name', async ({ setup }) => {
    setup();
    const removeReaction = vi.fn().mockResolvedValue(undefined);

    await expect(
      startNewDiscordTask({
        provider: { removeReaction } as never,
        applicationId: 'application-1',
        requesterDiscordUserId: 'discord-user-1',
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
