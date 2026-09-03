const mocks = vi.hoisted(() => ({
  acquireTurnLock: vi.fn(),
  releaseTurnLock: Object.assign(vi.fn(), {
    signal: new AbortController().signal,
    abort: vi.fn(),
    abortForShutdown: vi.fn(),
    shutdownCloseoutSettled: Promise.resolve(),
  }),
  acquireRootBindingLock: vi.fn(),
  releaseRootBindingLock: vi.fn(),
  answerQuestion: vi.fn(),
  createLauncher: vi.fn(),
  launchTask: vi.fn(),
  findSession: vi.fn(),
  bindConversation: vi.fn(),
  findInstallation: vi.fn(),
  findCustomAutomation: vi.fn(),
  findArtifacts: vi.fn(),
  findTaskRun: vi.fn(),
  findTaskPullRequests: vi.fn(),
  postMessage: vi.fn(),
  updateMessage: vi.fn(),
  addReaction: vi.fn(),
  resolveSlackReactionNames: vi.fn(),
  createDiscordProvider: vi.fn(),
  discordPostMessage: vi.fn(),
  discordEditMessage: vi.fn(),
  createDiscordThread: vi.fn(),
  createTeamsProvider: vi.fn(),
  teamsPostMessage: vi.fn(),
  teamsUpdateMessage: vi.fn(),
  createTelegramProvider: vi.fn(),
  telegramPostMessage: vi.fn(),
  findTeamsConversationRoute: vi.fn(),
  recordProviderMessage: vi.fn(),
  enqueueTask: vi.fn(),
  getTaskUrl: vi.fn(),
  setPendingPrReviewAction: vi.fn(),
  attachPendingPrReviewActionMessage: vi.fn(),
  retirePrReviewActionMessagesBestEffort: vi.fn(),
  buildSlackPrReviewActionBlocks: vi.fn(),
  resolveUserMcpServerConfigs: vi.fn(),
  appendSuggestionInstruction: vi.fn((message: string) => message),
  postSlackSuggestions: vi.fn(),
  postDiscordSuggestions: vi.fn(),
  postTeamsSuggestions: vi.fn(),
  postTelegramSuggestions: vi.fn(),
  buildSourceControlFastDelivery: vi.fn(),
  postSourceControlComment: vi.fn(),
}));

vi.mock('@roomote/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/redis')>();
  return {
    ...actual,
    // The sticky-footer lock and state live in Redis; these tests run without
    // a server, so satisfy lock acquisition and empty prior state.
    getRedis: () => ({
      set: async () => 'OK',
      get: async () => null,
      eval: async () => 1,
    }),
  };
});

vi.mock('@roomote/communication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/communication')>()),
  resolveFastSessionReplyFooterContext: vi.fn(
    async ({ pullRequest, pullRequests = [] }) => ({
      linkedPrs: [...(pullRequest ? [pullRequest] : []), ...pullRequests].map(
        ({ number, url }) => ({ prNumber: number, prUrl: url }),
      ),
      livePreviewUrl: null,
    }),
  ),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireTurnLock,
  answerFastAgentQuestion: mocks.answerQuestion,
  resolveApiBaseUrl: () => 'https://roomote.example.com',
  fastAgentConversationRepository: {
    findById: mocks.findSession,
    getOrCreate: mocks.bindConversation,
  },
  createFastAgentTaskLauncher:
    ({
      buildTask,
    }: {
      buildTask: (input: {
        prompt: string;
        environmentId: string | null;
        model?: string | null;
        parentSessionId: string;
      }) => unknown | Promise<unknown>;
    }) =>
    async (input: {
      prompt: string;
      environmentId: string | null;
      model?: string | null;
      parentSessionId: string;
      postKickoff: (task: {
        taskId: string;
        taskUrl?: string;
      }) => Promise<void>;
    }) => {
      const task = await buildTask(input);
      const taskUrl = mocks.getTaskUrl();
      await input.postKickoff({ taskId: 'child-task-1', taskUrl });
      await mocks.enqueueTask({ task });
      return { success: true, taskId: 'child-task-1', taskUrl };
    },
  createFastAgentWebTaskLauncher: vi.fn(() => mocks.launchTask),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      slackInstallations: { findFirst: mocks.findInstallation },
      taskArtifacts: { findMany: mocks.findArtifacts },
      taskPullRequests: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: mocks.findTaskPullRequests,
      },
      taskRuns: { findFirst: mocks.findTaskRun },
    },
  },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  inArray: vi.fn((...args: unknown[]) => args),
  getCustomAutomationById: mocks.findCustomAutomation,
  slackInstallations: {
    isActive: 'slack_installations.is_active',
    teamId: 'slack_installations.team_id',
  },
  taskArtifacts: { id: 'task_artifacts.id' },
  taskPullRequests: { taskId: 'task_pull_requests.task_id' },
  taskRuns: { id: 'task_runs.id' },
}));

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://api.roomote.example' },
  getArtifactSigningKey: vi.fn(() => 'signing-key'),
}));

vi.mock('@roomote/slack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/slack')>()),
  acquireSlackFastRootBindingLock: mocks.acquireRootBindingLock,
  SlackNotifier: class SlackNotifier {
    postMessage = mocks.postMessage;
    updateMessage = mocks.updateMessage;
    addReaction = mocks.addReaction;
  },
  buildSlackPrReviewActionBlocks: mocks.buildSlackPrReviewActionBlocks,
  resolveSlackReactionNames: mocks.resolveSlackReactionNames,
  createFastAgentSlackLiveTaskLauncher: mocks.createLauncher,
}));

vi.mock('./task-runs/pr-review-action', () => ({
  setPendingPrReviewAction: mocks.setPendingPrReviewAction,
  attachPendingPrReviewActionMessageWithRetirement:
    mocks.attachPendingPrReviewActionMessage,
  retirePrReviewActionMessagesBestEffort:
    mocks.retirePrReviewActionMessagesBestEffort,
}));

vi.mock('./artifacts/raw-url', () => ({
  buildSignedArtifactRawUrl: vi.fn(
    ({ artifactId }: { artifactId: string }) =>
      `https://api.roomote.example/api/artifacts/${artifactId}/raw?signed=1`,
  ),
  currentEpochSeconds: vi.fn(() => 1234),
}));

vi.mock('./discord-communication', () => ({
  createDiscordCommunicationProviderFromRuntimeCredentials:
    mocks.createDiscordProvider,
}));

vi.mock('./teams-communication', () => ({
  createTeamsCommunicationProviderFromRuntimeCredentials:
    mocks.createTeamsProvider,
}));

vi.mock('./telegram-communication', () => ({
  createTelegramCommunicationProviderFromRuntimeCredentials:
    mocks.createTelegramProvider,
}));

vi.mock('../automations/destination', () => ({
  findTeamsConversationRoute: mocks.findTeamsConversationRoute,
}));

vi.mock('./fast-agent-provider-message', () => ({
  recordFastAgentConversationMessageBestEffort: mocks.recordProviderMessage,
}));

vi.mock('../routers/mcp-connections', () => ({
  resolveUserMcpServerConfigs: mocks.resolveUserMcpServerConfigs,
}));

vi.mock('./fast-automation-suggestions', () => ({
  appendFastAutomationSuggestionInstruction: mocks.appendSuggestionInstruction,
  postFastAutomationSuggestionsToSlack: mocks.postSlackSuggestions,
  postFastAutomationSuggestionsToDiscord: mocks.postDiscordSuggestions,
  postFastAutomationSuggestionsToTeams: mocks.postTeamsSuggestions,
  postFastAutomationSuggestionsToTelegram: mocks.postTelegramSuggestions,
}));

vi.mock('./source-control-fast-delivery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./source-control-fast-delivery')>()),
  buildSourceControlFastDelivery: mocks.buildSourceControlFastDelivery,
}));

import {
  deliverFastAgentParentEvent,
  deliverFastAgentParentEventWithLock,
  FastAgentParentEventDeliveryError,
} from './fast-agent-parent-event';

const parent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  conversation: {
    surface: 'slack' as const,
    workspaceId: 'T123',
    conversationId: '100.001',
    replyTarget: { channelId: 'C123', threadId: '100.001' },
  },
};

const event = {
  type: 'artifact_published' as const,
  taskId: 'task-1',
  runId: 42,
  artifact: {
    id: 'artifact-1',
    path: 'proof/result.png',
    version: 1,
    contentType: 'image/png',
    viewUrl:
      'https://roomote.example/task/task-1/artifacts/proof/result.png?v=1',
  },
};

describe('deliverFastAgentParentEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.releaseTurnLock.signal = new AbortController().signal;
    mocks.acquireTurnLock.mockResolvedValue(mocks.releaseTurnLock);
    mocks.acquireRootBindingLock.mockResolvedValue(
      mocks.releaseRootBindingLock,
    );
    mocks.releaseTurnLock.mockResolvedValue(undefined);
    mocks.releaseRootBindingLock.mockResolvedValue(undefined);
    mocks.findSession.mockImplementation(
      async ({ fallbackConversation }: { fallbackConversation: unknown }) => ({
        id: parent.sessionId,
        userId: 'u1',
        conversation: fallbackConversation,
        messages: [],
      }),
    );
    mocks.findInstallation.mockResolvedValue({
      botAccessToken: 'xoxb-test',
      teamDomain: 'acme',
    });
    mocks.findCustomAutomation.mockResolvedValue({
      id: 'automation-1',
      name: 'Weekly scan',
    });
    mocks.bindConversation.mockImplementation(
      async ({ conversation }: { conversation: unknown }) => ({
        id: parent.sessionId,
        userId: 'u1',
        conversation,
        compatibilityMessages: [],
        openCodeSessionId: null,
      }),
    );
    mocks.createLauncher.mockReturnValue(mocks.launchTask);
    mocks.findArtifacts.mockResolvedValue([
      {
        id: 'artifact-1',
        taskId: 'task-1',
        runId: 42,
        path: 'proof/result.png',
        contentType: 'image/png',
        uploaded: true,
      },
    ]);
    mocks.findTaskRun.mockResolvedValue({ status: 'running' });
    mocks.findTaskPullRequests.mockResolvedValue([]);
    mocks.postMessage.mockResolvedValue('101.001');
    mocks.updateMessage.mockResolvedValue(true);
    mocks.addReaction.mockResolvedValue(true);
    mocks.resolveSlackReactionNames.mockResolvedValue({
      ackEmoji: 'eyes',
      completionEmoji: 'white_check_mark',
    });
    mocks.resolveUserMcpServerConfigs.mockResolvedValue({});
    mocks.postSlackSuggestions.mockResolvedValue(undefined);
    mocks.postDiscordSuggestions.mockResolvedValue(undefined);
    mocks.postTeamsSuggestions.mockResolvedValue(undefined);
    mocks.postTelegramSuggestions.mockResolvedValue(undefined);
    mocks.setPendingPrReviewAction.mockResolvedValue(undefined);
    mocks.attachPendingPrReviewActionMessage.mockResolvedValue({
      attached: true,
      superseded: [],
    });
    mocks.retirePrReviewActionMessagesBestEffort.mockResolvedValue(undefined);
    mocks.buildSlackPrReviewActionBlocks.mockImplementation(
      ({ text, question, nonce }) => [
        { type: 'section', text: { type: 'mrkdwn', text } },
        {
          type: 'section',
          block_id: 'pr_review_action_question',
          text: { type: 'mrkdwn', text: question },
        },
        { type: 'actions', nonce },
      ],
    );
    mocks.discordPostMessage.mockResolvedValue({
      provider: 'discord',
      channelId: 'channel-1',
      threadId: 'thread-1',
      messageId: 'message-1',
    });
    mocks.createDiscordThread.mockResolvedValue({
      channelId: 'child-thread-1',
      parentChannelId: 'channel-1',
      messageId: 'child-message-1',
      name: 'Child task',
      kind: 'thread',
    });
    mocks.createDiscordProvider.mockResolvedValue({
      postMessage: mocks.discordPostMessage,
      editMessage: mocks.discordEditMessage,
      createTaskThread: mocks.createDiscordThread,
    });
    mocks.teamsPostMessage.mockResolvedValue({
      provider: 'teams',
      channelId: 'teams-channel-1',
      messageId: 'teams-message-1',
    });
    mocks.createTeamsProvider.mockResolvedValue({
      postMessage: mocks.teamsPostMessage,
      updateMessage: mocks.teamsUpdateMessage,
    });
    mocks.telegramPostMessage.mockResolvedValue({
      provider: 'telegram',
      channelId: 'telegram-chat-1',
      messageId: 'telegram-message-1',
      lastTextMessageId: 'telegram-message-2',
    });
    mocks.createTelegramProvider.mockResolvedValue({
      postMessage: mocks.telegramPostMessage,
    });
    mocks.findTeamsConversationRoute.mockResolvedValue({
      serviceUrl: 'https://smba.example.com/amer/',
      workspaceId: 'tenant-1',
    });
    mocks.recordProviderMessage.mockResolvedValue(true);
    mocks.getTaskUrl.mockReturnValue(
      'https://roomote.example/task/child-task-1',
    );
    mocks.enqueueTask.mockImplementation(
      async (
        _input: unknown,
        options?: {
          beforeEnqueue?: (run: { taskId: string }) => Promise<void>;
        },
      ) => {
        await options?.beforeEnqueue?.({ taskId: 'child-task-1' });
        return { taskId: 'child-task-1' };
      },
    );
    mocks.answerQuestion.mockImplementation(
      async ({
        adapter,
      }: {
        adapter: { postReply: (reply: unknown) => unknown };
      }) =>
        adapter.postReply({
          purpose: 'closeout',
          message: 'The proof is ready.',
          imageArtifactIds: ['artifact-1', 'artifact-1'],
        }),
    );
  });

  it('delivers a human follow-up queued at response finalization as the next turn', async () => {
    mocks.answerQuestion.mockResolvedValueOnce('Updated response');

    await deliverFastAgentParentEventWithLock(
      {
        parent,
        event: {
          type: 'human_follow_up',
          eventId: '100.003',
          currentMessageId: '100.003',
          userId: 'user-2',
          question: 'Use the corrected requirement.',
          images: ['data:image/png;base64,aGVsbG8='],
          senderDisplayName: 'Matt',
          senderExternalId: 'U123',
        },
      },
      mocks.releaseTurnLock,
    );

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'Use the corrected requirement.',
        images: ['data:image/png;base64,aGVsbG8='],
        userId: 'user-2',
        currentMessageId: '100.003',
        currentDurableHumanFollowUpEventId: '100.003',
        senderDisplayName: 'Matt',
        senderExternalId: 'U123',
        turnSource: 'human',
        signal: mocks.releaseTurnLock.signal,
      }),
    );
    expect(mocks.createLauncher).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-2' }),
    );
    const answerInput = mocks.answerQuestion.mock.calls[0]?.[0];
    await answerInput.adapter.resolveMcpServerConfigs();
    expect(mocks.resolveUserMcpServerConfigs).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-2' }),
    );
  });

  it('passes a canonical review offer into the web transcript payload', async () => {
    const webParent = {
      sessionId: parent.sessionId,
      conversation: {
        surface: 'web' as const,
        workspaceId: 'user-1',
        conversationId: 'session-1',
      },
    };
    mocks.answerQuestion.mockResolvedValue('Presented feedback');

    await deliverFastAgentParentEvent({
      parent: webParent,
      event: {
        type: 'pull_request_feedback',
        feedbackId: 'feedback-1',
        taskId: 'task-1',
        runId: 42,
        taskUrl: 'https://roomote.example/task/task-1',
        pullRequest: {
          provider: 'github',
          host: 'github.com',
          repository: 'acme/web',
          number: 42,
          title: 'Fix review feedback',
          url: 'https://github.com/acme/web/pull/42',
          status: 'open',
        },
        summary: 'Review feedback remains.',
        suggestedActionQuestion: 'Resolve these issues?',
        suggestedActionPrompt: 'Resolve the review feedback.',
        reviewActionDeliveryId: '22222222-2222-4222-8222-222222222222',
      },
    });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        platformEventTranscriptPayload: {
          prReviewAction: {
            deliveryId: '22222222-2222-4222-8222-222222222222',
            question: 'Resolve these issues?',
            status: 'pending',
          },
        },
      }),
    );
  });

  it('serializes the event and posts one copy of a selected inline image', async () => {
    await deliverFastAgentParentEvent({ parent, event });

    expect(mocks.acquireTurnLock).toHaveBeenCalledWith({
      conversation: {
        surface: 'slack' as const,
        workspaceId: 'T123',
        conversationId: '100.001',
        replyTarget: { channelId: 'C123', threadId: '100.001' },
      },
    });
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessageId: 'fast-parent-artifact:artifact-1:v1',
        turnSource: 'platform_event',
        adapter: expect.objectContaining({ launchTask: mocks.launchTask }),
      }),
    );
    expect(mocks.createLauncher).toHaveBeenCalledWith({
      slack: expect.any(Object),
      userId: 'u1',
      teamId: 'T123',
      teamDomain: 'acme',
      channelId: 'C123',
      threadTs: '100.001',
    });
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '100.001',
        blocks: [
          { type: 'markdown', text: 'The proof is ready.' },
          {
            type: 'image',
            image_url:
              'https://api.roomote.example/api/artifacts/artifact-1/raw?signed=1',
            alt_text: 'result.png',
          },
          {
            type: 'context',
            block_id: 'roomote_thread_reply_footer',
            elements: [
              {
                type: 'mrkdwn',
                text: expect.stringContaining('Reply or use the'),
              },
            ],
          },
        ],
      }),
    );
    expect(mocks.releaseTurnLock).toHaveBeenCalledOnce();
  });

  it('keeps child lifecycle text private until the Fast parent composes a reply', async () => {
    const childEvent = {
      type: 'child_message' as const,
      taskId: 'task-1',
      runId: 42,
      messageId: '22222222-2222-4222-8222-222222222222',
      purpose: 'progress' as const,
      message: 'The child is running targeted tests.',
    };

    await deliverFastAgentParentEvent({ parent, event: childEvent });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.stringContaining(
          '"message":"The child is running targeted tests."',
        ),
        turnSource: 'platform_event',
      }),
    );
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'The proof is ready.',
        client_msg_id: expect.any(String),
      }),
    );
    expect(mocks.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: childEvent.message }),
    );
    expect(mocks.recordProviderMessage).toHaveBeenCalledWith({
      sessionId: parent.sessionId,
      conversation: parent.conversation,
      messageId: '101.001',
    });
  });

  it('captures an automation platform turn without a chat provider', async () => {
    const automationParent = {
      sessionId: parent.sessionId,
      conversation: {
        surface: 'automation' as const,
        workspaceId: 'automation-1',
        conversationId: 'occurrence-1',
      },
    };

    await expect(
      deliverFastAgentParentEvent({
        parent: automationParent,
        event: {
          type: 'automation_triggered',
          eventId: 'occurrence-1',
          automationId: 'automation-1',
          automationName: 'Weekly scan',
          prompt: 'Find actionable regressions.',
          trigger: 'schedule',
        },
      }),
    ).resolves.toBe('delivered');

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: automationParent.conversation,
        platformEventKind: 'automation',
        platformEventVisibility: 'required',
        turnSource: 'platform_event',
      }),
    );
    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(mocks.createDiscordProvider).not.toHaveBeenCalled();
  });

  it('updates the Slack root for a channel-backed automation turn', async () => {
    await deliverFastAgentParentEvent({
      parent,
      event: {
        type: 'automation_triggered',
        eventId: 'occurrence-1',
        automationId: 'automation-1',
        automationName: 'Weekly scan',
        prompt: 'Find actionable regressions.',
        trigger: 'schedule',
        rootMessageId: '100.001',
      },
    });

    expect(mocks.updateMessage).toHaveBeenCalledWith({
      channel: 'C123',
      ts: '100.001',
      message: {
        text: 'The proof is ready.',
        blocks: [
          expect.objectContaining({
            type: 'context',
            elements: expect.arrayContaining([
              expect.objectContaining({ text: 'Weekly scan' }),
            ]),
          }),
          { type: 'markdown', text: 'The proof is ready.' },
          expect.objectContaining({
            type: 'actions',
            elements: [
              expect.objectContaining({
                action_id: 'late_bound_automation_view_session',
                text: expect.objectContaining({ text: 'Follow' }),
                url: expect.stringContaining(`/sessions/${parent.sessionId}`),
              }),
              expect.objectContaining({
                action_id: 'late_bound_automation_configure',
                url: expect.stringContaining(
                  '/automations#custom-automation-automation-1',
                ),
              }),
            ],
          }),
        ],
      },
    });
    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(mocks.recordProviderMessage).toHaveBeenCalledWith({
      sessionId: parent.sessionId,
      conversation: parent.conversation,
      messageId: '100.001',
    });
  });

  it('posts structured suggestions beneath a Fast Slack automation report', async () => {
    const suggestions = [
      {
        title: 'Investigate checkout latency',
        brief: 'Trace the slow payment-provider requests.',
      },
    ];
    mocks.answerQuestion.mockImplementationOnce(
      async ({
        adapter,
      }: {
        adapter: { postReply: (reply: unknown) => unknown };
      }) =>
        adapter.postReply({
          purpose: 'closeout',
          message: 'Checkout latency increased this week.',
          suggestions,
        }),
    );

    await deliverFastAgentParentEvent({
      parent,
      event: {
        type: 'automation_triggered',
        eventId: 'occurrence-1',
        automationId: 'automation-1',
        automationName: 'Weekly scan',
        prompt: 'Find actionable regressions.',
        trigger: 'schedule',
        rootMessageId: '100.001',
      },
    });

    expect(mocks.appendSuggestionInstruction).toHaveBeenCalledWith(
      'Checkout latency increased this week.',
      'slack',
      true,
    );
    expect(mocks.postSlackSuggestions).toHaveBeenCalledWith({
      slack: expect.any(Object),
      channelId: 'C123',
      threadTs: '100.001',
      eventId: 'occurrence-1',
      createdByUserId: 'u1',
      suggestions,
    });
  });

  it('posts Discord automation suggestions when no editable root message exists', async () => {
    const discordParent = {
      ...parent,
      conversation: {
        surface: 'discord' as const,
        workspaceId: 'guild-1',
        conversationId: 'thread-1',
        replyTarget: { channelId: 'channel-1', threadId: 'thread-1' },
      },
    };
    const suggestions = [
      { title: 'Verify retry behavior', brief: 'Exercise the failure path.' },
    ];
    mocks.answerQuestion.mockImplementationOnce(
      async ({
        adapter,
      }: {
        adapter: { postReply: (reply: unknown) => unknown };
      }) =>
        adapter.postReply({
          purpose: 'closeout',
          message: 'Retry failures increased.',
          suggestions,
        }),
    );

    await deliverFastAgentParentEvent({
      parent: discordParent,
      event: {
        type: 'automation_triggered',
        eventId: 'occurrence-2',
        automationId: 'automation-2',
        automationName: 'Retry scan',
        prompt: 'Find actionable retry failures.',
        trigger: 'schedule',
      },
    });

    expect(mocks.discordEditMessage).not.toHaveBeenCalled();
    expect(mocks.discordPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'channel-1',
        threadId: 'thread-1',
        text: 'Retry failures increased.',
      }),
    );
    expect(mocks.postDiscordSuggestions).toHaveBeenCalledWith({
      provider: expect.any(Object),
      channelId: 'channel-1',
      threadId: 'thread-1',
      eventId: 'occurrence-2',
      createdByUserId: 'u1',
      suggestions,
    });
    expect(mocks.recordProviderMessage).toHaveBeenCalledWith({
      sessionId: parent.sessionId,
      conversation: discordParent.conversation,
      messageId: 'message-1',
    });
  });

  it('keeps a no-op pending Fast automation completely silent in Slack', async () => {
    const pendingParent = {
      sessionId: parent.sessionId,
      conversation: {
        surface: 'slack' as const,
        workspaceId: 'T123',
        conversationId: 'automation-1:occurrence-1',
        replyTarget: { channelId: 'C123' },
      },
    };
    mocks.answerQuestion.mockResolvedValueOnce('');

    await deliverFastAgentParentEvent({
      parent: pendingParent,
      event: {
        type: 'automation_triggered',
        eventId: 'occurrence-1',
        automationId: 'automation-1',
        automationName: 'Weekly scan',
        prompt: 'Report only actionable findings.',
        trigger: 'schedule',
      },
    });

    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(mocks.updateMessage).not.toHaveBeenCalled();
    expect(mocks.bindConversation).not.toHaveBeenCalled();
  });

  it('creates the delayed Slack root for a meaningful artifact closeout', async () => {
    const pendingParent = {
      sessionId: parent.sessionId,
      conversation: {
        surface: 'slack' as const,
        workspaceId: 'T123',
        conversationId: 'automation-1:occurrence-1',
        replyTarget: { channelId: 'C123' },
      },
    };

    await deliverFastAgentParentEvent({
      parent: pendingParent,
      event,
    });

    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        text: 'The proof is ready.',
        blocks: expect.arrayContaining([
          { type: 'markdown', text: 'The proof is ready.' },
          expect.objectContaining({ type: 'image' }),
        ]),
      }),
    );
    expect(mocks.bindConversation).toHaveBeenCalledWith({
      userId: 'u1',
      conversation: {
        ...pendingParent.conversation,
        replyTarget: { channelId: 'C123', threadId: '101.001' },
      },
    });
  });

  it('marks delivery complete when Slack posts before root binding fails', async () => {
    const pendingParent = {
      sessionId: parent.sessionId,
      conversation: {
        surface: 'slack' as const,
        workspaceId: 'T123',
        conversationId: 'automation-1:occurrence-1',
        replyTarget: { channelId: 'C123' },
      },
    };
    mocks.bindConversation.mockRejectedValueOnce(new Error('database offline'));

    const error = await deliverFastAgentParentEvent({
      parent: pendingParent,
      event,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(FastAgentParentEventDeliveryError);
    expect(error).toMatchObject({
      message: 'database offline',
      replyPosted: true,
    });

    expect(mocks.postMessage).toHaveBeenCalledOnce();
  });

  it('creates the first Slack message when a pending Fast automation settles', async () => {
    const pendingParent = {
      sessionId: parent.sessionId,
      conversation: {
        surface: 'slack' as const,
        workspaceId: 'T123',
        conversationId: 'automation-1:occurrence-1',
        replyTarget: { channelId: 'C123' },
      },
    };

    await deliverFastAgentParentEvent({
      parent: pendingParent,
      event: {
        type: 'task_settled',
        taskId: 'child-task-1',
        runId: 42,
        customAutomationId: 'automation-1',
        status: 'completed',
        taskUrl: 'https://roomote.example/task/child-task-1',
        pullRequests: [],
      },
    });

    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        client_msg_id: expect.any(String),
        text: 'The proof is ready.',
        blocks: [
          expect.objectContaining({
            type: 'context',
            elements: expect.arrayContaining([
              expect.objectContaining({ text: 'Weekly scan' }),
            ]),
          }),
          { type: 'markdown', text: 'The proof is ready.' },
          expect.objectContaining({
            type: 'actions',
            elements: expect.arrayContaining([
              expect.objectContaining({
                action_id: 'late_bound_automation_view_task',
              }),
              expect.objectContaining({
                action_id: 'late_bound_automation_configure',
              }),
            ]),
          }),
        ],
      }),
    );
    expect(mocks.updateMessage).not.toHaveBeenCalled();
    expect(mocks.bindConversation).toHaveBeenCalledWith({
      userId: 'u1',
      conversation: {
        ...pendingParent.conversation,
        replyTarget: { channelId: 'C123', threadId: '101.001' },
      },
    });
    expect(
      mocks.acquireRootBindingLock.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.postMessage.mock.invocationCallOrder[0]!);
    expect(mocks.postMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.bindConversation.mock.invocationCallOrder[0]!,
    );
    expect(mocks.bindConversation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.releaseRootBindingLock.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps a failed pending Fast automation silent in Slack', async () => {
    const pendingParent = {
      sessionId: parent.sessionId,
      conversation: {
        surface: 'slack' as const,
        workspaceId: 'T123',
        conversationId: 'automation-1:occurrence-1',
        replyTarget: { channelId: 'C123' },
      },
    };

    await deliverFastAgentParentEvent({
      parent: pendingParent,
      event: {
        type: 'task_settled',
        taskId: 'child-task-1',
        runId: 42,
        customAutomationId: 'automation-1',
        status: 'failed',
        error: 'Sandbox startup failed.',
        taskUrl: 'https://roomote.example/task/child-task-1',
        pullRequests: [],
      },
    });

    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(mocks.updateMessage).not.toHaveBeenCalled();
    expect(mocks.bindConversation).not.toHaveBeenCalled();
  });

  it('replaces an input root with the completed automation result', async () => {
    await deliverFastAgentParentEvent({
      parent,
      event: {
        type: 'task_settled',
        taskId: 'child-task-1',
        runId: 42,
        customAutomationId: 'automation-1',
        status: 'completed',
        taskUrl: 'https://roomote.example/task/child-task-1',
        pullRequests: [],
      },
    });

    expect(mocks.updateMessage).toHaveBeenCalledWith({
      channel: 'C123',
      ts: '100.001',
      message: expect.objectContaining({
        text: 'The proof is ready.',
        blocks: expect.arrayContaining([
          { type: 'markdown', text: 'The proof is ready.' },
          expect.objectContaining({
            type: 'actions',
            elements: expect.arrayContaining([
              expect.objectContaining({
                action_id: 'late_bound_automation_view_task',
              }),
            ]),
          }),
        ]),
      }),
    });
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it('relays child lifecycle events into a stored automation conversation', async () => {
    const automationParent = {
      sessionId: parent.sessionId,
      conversation: {
        surface: 'automation' as const,
        workspaceId: 'automation-1',
        conversationId: 'occurrence-1',
      },
    };

    await deliverFastAgentParentEvent({
      parent: automationParent,
      event: {
        type: 'task_settled',
        taskId: 'child-task-1',
        runId: 42,
        status: 'completed',
        taskUrl: 'https://roomote.example/task/child-task-1',
        pullRequests: [],
      },
    });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: automationParent.conversation,
        platformEventKind: 'delegated_task',
        turnSource: 'platform_event',
      }),
    );
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it('delegates a task with the stored automation conversation as its Fast parent', async () => {
    const automationParent = {
      sessionId: parent.sessionId,
      conversation: {
        surface: 'automation' as const,
        workspaceId: 'automation-1',
        conversationId: 'occurrence-1',
      },
    };
    mocks.answerQuestion.mockImplementationOnce(
      async ({
        adapter,
      }: {
        adapter: {
          launchTask: typeof mocks.launchTask;
          resolveMcpServerConfigs: () => Promise<unknown>;
        };
      }) => {
        await adapter.resolveMcpServerConfigs();
        return adapter.launchTask({
          prompt: 'Inspect the repository.',
          environmentId: null,
          parentSessionId: automationParent.sessionId,
          postKickoff: vi.fn(),
        });
      },
    );

    await deliverFastAgentParentEvent({
      parent: automationParent,
      event: {
        type: 'automation_triggered',
        eventId: 'occurrence-1',
        automationId: 'automation-1',
        automationName: 'Weekly scan',
        prompt: 'Find actionable regressions.',
        trigger: 'schedule',
        defaultTaskModel: 'openai/gpt-5.6-luna',
        defaultTaskReasoningEffort: 'high',
      },
    });

    expect(mocks.resolveUserMcpServerConfigs).toHaveBeenCalledWith({
      userId: 'u1',
      apiBaseUrl: 'https://roomote.example.com',
      includeRoomoteMemberTools: true,
    });
    expect(mocks.enqueueTask).toHaveBeenCalledWith({
      task: expect.objectContaining({
        payload: expect.objectContaining({
          fastAgentSessionId: automationParent.sessionId,
          fastAgentParent: automationParent,
          harnessModelOverrides: {
            'opencode-server': 'openai/gpt-5.6-luna',
          },
          reasoningEffort: 'high',
        }),
      }),
    });
  });

  it('uses a stable delivery key when the same child update is retried', async () => {
    const childEvent = {
      type: 'child_message' as const,
      taskId: 'task-1',
      runId: 42,
      messageId: '22222222-2222-4222-8222-222222222222',
      purpose: 'progress' as const,
      message: 'The child is running targeted tests.',
    };

    await deliverFastAgentParentEvent({ parent, event: childEvent });
    await deliverFastAgentParentEvent({ parent, event: childEvent });

    expect(mocks.postMessage.mock.calls[0]?.[0]?.client_msg_id).toBe(
      mocks.postMessage.mock.calls[1]?.[0]?.client_msg_id,
    );
  });

  it('does not start a model turn when the shared chat lock is unavailable', async () => {
    mocks.acquireTurnLock.mockResolvedValueOnce(null);

    await expect(
      deliverFastAgentParentEvent({ parent, event }),
    ).rejects.toThrow('turn lock did not become available');
    expect(mocks.answerQuestion).not.toHaveBeenCalled();
  });

  it('delivers a guild parent event to its routable channel, not its session identity', async () => {
    const discordParent = {
      ...parent,
      conversation: {
        surface: 'discord' as const,
        workspaceId: 'guild-1',
        conversationId: 'interaction-fast-guild',
        replyTarget: { channelId: 'channel-1' },
      },
    };

    await expect(
      deliverFastAgentParentEvent({ parent: discordParent, event }),
    ).resolves.toBe('delivered');

    expect(mocks.discordPostMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      idempotencyKey: 'fast-parent-artifact:artifact-1:v1',
      text: expect.stringMatching(
        /^The proof is ready\.\n\n-# Reply or use the \[web app\]\(.*\/sessions\/.*\)\.$/,
      ),
      textFormat: 'markdown',
      images: [
        {
          url: 'https://api.roomote.example/api/artifacts/artifact-1/raw?signed=1',
          altText: 'result.png',
          contentType: 'image/png',
        },
      ],
    });
    expect(mocks.releaseTurnLock).toHaveBeenCalledOnce();
  });

  it('delivers a threaded Discord parent event inside the provider thread', async () => {
    await deliverFastAgentParentEvent({
      parent: {
        ...parent,
        conversation: {
          surface: 'discord',
          workspaceId: 'guild-1',
          conversationId: 'thread-1',
          replyTarget: { channelId: 'channel-1', threadId: 'thread-1' },
        },
      },
      event,
    });

    // The adapter hands back the posted message so a later edit (a retry
    // notice becoming the answer) can target it, also from a resumed run.
    await expect(
      mocks.answerQuestion.mock.results.at(-1)!.value,
    ).resolves.toEqual({ messageId: 'message-1' });
    expect(mocks.discordPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'channel-1',
        threadId: 'thread-1',
      }),
    );
  });

  it.each([
    {
      surface: 'teams' as const,
      workspaceId: 'tenant-1',
      channelId: 'teams-channel-1',
      threadId: 'teams-root-1',
      post: mocks.teamsPostMessage,
    },
    {
      surface: 'telegram' as const,
      workspaceId: 'telegram-chat-1',
      channelId: 'telegram-chat-1',
      threadId: undefined,
      post: mocks.telegramPostMessage,
    },
  ])(
    'delivers a $surface parent event through its provider adapter',
    async ({ surface, workspaceId, channelId, threadId, post }) => {
      await deliverFastAgentParentEvent({
        parent: {
          ...parent,
          conversation: {
            surface,
            workspaceId,
            conversationId: `${surface}-conversation-1`,
            replyTarget: {
              channelId,
              ...(threadId ? { threadId } : {}),
            },
          },
        },
        event,
      });

      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId,
          ...(threadId ? { threadId } : {}),
          text: expect.stringMatching(
            new RegExp(
              `^The proof is ready\\.\\n\\n.*Reply or use the \\[web app\\]\\(.*utm_source=${surface}.*\\)\\..*$`,
            ),
          ),
          textFormat: 'markdown',
          images: [
            {
              url: 'https://api.roomote.example/api/artifacts/artifact-1/raw?signed=1',
              altText: 'result.png',
              contentType: 'image/png',
            },
          ],
        }),
      );
    },
  );

  it('updates the Teams automation root instead of posting a duplicate report', async () => {
    await deliverFastAgentParentEvent({
      parent: {
        ...parent,
        conversation: {
          surface: 'teams',
          workspaceId: 'tenant-1',
          conversationId: 'teams-occurrence-1',
          replyTarget: {
            channelId: 'teams-channel-1',
            threadId: 'teams-root-1',
            serviceUrl: 'https://stale.example.com/amer/',
          },
        },
      },
      event: {
        type: 'automation_triggered',
        eventId: 'teams-occurrence-1',
        automationId: 'automation-1',
        automationName: 'Weekly scan',
        prompt: 'Find actionable regressions.',
        trigger: 'schedule',
        rootMessageId: 'teams-root-1',
      },
    });

    expect(mocks.teamsUpdateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'teams-channel-1',
        messageId: 'teams-root-1',
        serviceUrl: 'https://smba.example.com/amer/',
        textFormat: 'markdown',
      }),
    );
    expect(mocks.teamsPostMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      surface: 'teams' as const,
      workspaceId: 'tenant-1',
      channelId: 'teams-channel-1',
      threadId: 'teams-root-1',
      rootMessageId: 'teams-root-1',
      postSuggestions: mocks.postTeamsSuggestions,
    },
    {
      surface: 'teams' as const,
      workspaceId: 'tenant-1',
      channelId: 'teams-channel-1',
      threadId: undefined,
      rootMessageId: undefined,
      postSuggestions: mocks.postTeamsSuggestions,
    },
    {
      surface: 'telegram' as const,
      workspaceId: 'telegram-chat-1',
      channelId: 'telegram-chat-1',
      threadId: undefined,
      rootMessageId: undefined,
      postSuggestions: mocks.postTelegramSuggestions,
    },
  ])(
    'posts structured suggestions beneath a Fast $surface automation report',
    async ({
      surface,
      workspaceId,
      channelId,
      threadId,
      rootMessageId,
      postSuggestions,
    }) => {
      const suggestions = [
        { title: 'Verify retry behavior', brief: 'Exercise the failure path.' },
      ];
      mocks.answerQuestion.mockImplementationOnce(
        async ({
          adapter,
        }: {
          adapter: { postReply: (reply: unknown) => unknown };
        }) =>
          adapter.postReply({
            purpose: 'closeout',
            message: 'Retry failures increased.',
            suggestions,
          }),
      );

      await deliverFastAgentParentEvent({
        parent: {
          ...parent,
          conversation: {
            surface,
            workspaceId,
            conversationId: `${surface}-occurrence-1`,
            replyTarget: {
              channelId,
              ...(threadId ? { threadId } : {}),
            },
          },
        },
        event: {
          type: 'automation_triggered',
          eventId: `${surface}-occurrence-1`,
          automationId: 'automation-1',
          automationName: 'Retry scan',
          prompt: 'Find actionable retry failures.',
          trigger: 'schedule',
          ...(rootMessageId ? { rootMessageId } : {}),
        },
      });

      expect(postSuggestions).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId,
          eventId: `${surface}-occurrence-1`,
          createdByUserId: 'u1',
          suggestions,
        }),
      );
      expect(mocks.recordProviderMessage).toHaveBeenCalledWith({
        sessionId: parent.sessionId,
        conversation: expect.objectContaining({ surface }),
        messageId:
          rootMessageId ??
          (surface === 'teams' ? 'teams-message-1' : 'telegram-message-2'),
      });
    },
  );

  it("refreshes Teams routing from the persisted session's current channel", async () => {
    const fallbackConversation = {
      surface: 'teams' as const,
      workspaceId: 'tenant-1',
      conversationId: 'teams-occurrence-1',
      replyTarget: {
        channelId: 'stale-channel',
        threadId: 'stale-root',
        serviceUrl: 'https://stale.example.com/amer/',
      },
    };
    mocks.findSession.mockResolvedValueOnce({
      id: parent.sessionId,
      userId: 'u1',
      messages: [],
      conversation: {
        ...fallbackConversation,
        replyTarget: {
          channelId: 'current-channel',
          threadId: 'current-root',
          serviceUrl: 'https://also-stale.example.com/amer/',
        },
      },
    });
    mocks.findTeamsConversationRoute.mockResolvedValueOnce({
      serviceUrl: 'https://current.example.com/amer/',
      workspaceId: 'tenant-1',
    });

    await deliverFastAgentParentEvent({
      parent: {
        sessionId: parent.sessionId,
        conversation: fallbackConversation,
      },
      event,
    });

    expect(mocks.findTeamsConversationRoute).toHaveBeenCalledWith(
      'current-channel',
      'tenant-1',
    );
    expect(mocks.teamsPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'current-channel',
        threadId: 'current-root',
        serviceUrl: 'https://current.example.com/amer/',
      }),
    );
  });

  it('uses the persisted Teams DM service URL when no route row exists', async () => {
    const fallbackConversation = {
      surface: 'teams' as const,
      workspaceId: 'tenant-1',
      conversationId: 'teams-occurrence-1',
      replyTarget: {
        channelId: 'stale-channel',
        serviceUrl: 'https://stale.example.com/amer/',
      },
    };
    mocks.findSession.mockResolvedValueOnce({
      id: parent.sessionId,
      userId: 'u1',
      messages: [],
      conversation: {
        ...fallbackConversation,
        replyTarget: {
          channelId: 'teams-dm-1',
          serviceUrl: 'https://persisted.example.com/amer/',
        },
      },
    });
    mocks.findTeamsConversationRoute.mockResolvedValueOnce(null);

    await deliverFastAgentParentEvent({
      parent: {
        sessionId: parent.sessionId,
        conversation: fallbackConversation,
      },
      event,
    });

    expect(mocks.findTeamsConversationRoute).toHaveBeenCalledWith(
      'teams-dm-1',
      'tenant-1',
    );
    expect(mocks.teamsPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'teams-dm-1',
        serviceUrl: 'https://persisted.example.com/amer/',
      }),
    );
  });

  it('does not use a persisted Teams channel service URL without a route row', async () => {
    const fallbackConversation = {
      surface: 'teams' as const,
      workspaceId: 'tenant-1',
      conversationId: 'teams-occurrence-1',
      replyTarget: {
        channelId: 'teams-channel-1',
        threadId: 'teams-root-1',
        serviceUrl: 'https://persisted.example.com/amer/',
      },
    };
    mocks.findSession.mockResolvedValueOnce({
      id: parent.sessionId,
      userId: 'u1',
      messages: [],
      conversation: fallbackConversation,
    });
    mocks.findTeamsConversationRoute.mockResolvedValueOnce(null);

    await expect(
      deliverFastAgentParentEvent({
        parent: {
          sessionId: parent.sessionId,
          conversation: fallbackConversation,
        },
        event,
      }),
    ).rejects.toThrow('Fast Teams parent routing was not found.');
    expect(mocks.teamsPostMessage).not.toHaveBeenCalled();
  });

  it('uses the repository current destination instead of stale child metadata', async () => {
    mocks.findSession.mockResolvedValueOnce({
      id: parent.sessionId,
      userId: 'u1',
      messages: [],
      conversation: {
        ...parent.conversation,
        replyTarget: { channelId: 'C456', threadId: '200.002' },
      },
    });

    await deliverFastAgentParentEvent({ parent, event });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          replyTarget: { channelId: 'C456', threadId: '200.002' },
        }),
      }),
    );
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C456', thread_ts: '200.002' }),
    );
  });

  it('keeps launch_task available during a Discord parent event', async () => {
    const postKickoff = vi.fn().mockResolvedValue(undefined);
    mocks.answerQuestion.mockImplementationOnce(
      async ({
        adapter,
      }: {
        adapter: { launchTask: (input: unknown) => unknown };
      }) =>
        adapter.launchTask({
          prompt: 'Fix the follow-up regression',
          environmentId: null,
          model: 'anthropic/claude-sonnet-5',
          reasoningEffort: 'high',
          parentSessionId: parent.sessionId,
          postKickoff,
        }),
    );

    await deliverFastAgentParentEvent({
      parent: {
        ...parent,
        conversation: {
          surface: 'discord',
          workspaceId: 'guild-1',
          conversationId: 'thread-1',
          replyTarget: { channelId: 'channel-1', threadId: 'thread-1' },
        },
      },
      event,
    });

    expect(mocks.createDiscordThread).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'channel-1' }),
    );
    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            communicationProvider: 'discord',
            communicationThreadId: 'child-thread-1',
            harnessModelOverrides: {
              'opencode-server': 'anthropic/claude-sonnet-5',
            },
            reasoningEffort: 'high',
            communicationContextInherited: true,
            fastAgentSessionId: parent.sessionId,
            fastAgentParent: {
              sessionId: parent.sessionId,
              conversation: {
                surface: 'discord',
                workspaceId: 'guild-1',
                conversationId: 'thread-1',
                replyTarget: {
                  channelId: 'channel-1',
                  threadId: 'thread-1',
                },
              },
            },
          }),
        }),
      }),
    );
    expect(postKickoff).toHaveBeenCalledWith({
      taskId: 'child-task-1',
      taskUrl: 'https://roomote.example/task/child-task-1',
    });
  });

  it.each([
    {
      surface: 'teams' as const,
      workspaceId: 'tenant-1',
      channelId: 'teams-channel-1',
      threadId: 'teams-root-1',
      serviceUrl: 'https://smba.example.com/amer/',
    },
    {
      surface: 'telegram' as const,
      workspaceId: 'telegram-chat-1',
      channelId: 'telegram-chat-1',
      threadId: undefined,
      serviceUrl: undefined,
    },
  ])(
    'keeps launch_task provider-neutral during a $surface parent event',
    async ({ surface, workspaceId, channelId, threadId, serviceUrl }) => {
      mocks.answerQuestion.mockImplementationOnce(
        async ({
          adapter,
        }: {
          adapter: { launchTask: (input: unknown) => unknown };
        }) =>
          adapter.launchTask({
            prompt: 'Fix the follow-up regression',
            environmentId: null,
            model: null,
            reasoningEffort: 'xhigh',
            parentSessionId: parent.sessionId,
            postKickoff: vi.fn().mockResolvedValue(undefined),
          }),
      );

      await deliverFastAgentParentEvent({
        parent: {
          ...parent,
          conversation: {
            surface,
            workspaceId,
            conversationId: `${surface}-conversation-1`,
            replyTarget: {
              channelId,
              ...(threadId ? { threadId } : {}),
            },
          },
        },
        event,
      });

      expect(mocks.enqueueTask).toHaveBeenCalledWith(
        expect.objectContaining({
          task: expect.objectContaining({
            payload: expect.objectContaining({
              communicationProvider: surface,
              communicationChannelId: channelId,
              ...(threadId
                ? {
                    communicationThreadId: threadId,
                    communicationMessageId: threadId,
                  }
                : {}),
              ...(serviceUrl ? { communicationServiceUrl: serviceUrl } : {}),
              communicationContextInherited: true,
              fastAgentSessionId: parent.sessionId,
              reasoningEffort: 'xhigh',
            }),
          }),
        }),
      );
    },
  );

  it('delivers a pull request event with a stable Slack idempotency key', async () => {
    const pullRequestEvent = {
      type: 'pull_request_opened' as const,
      taskId: 'task-1',
      runId: 42,
      taskUrl: 'https://roomote.example/task/task-1',
      untrustedTaskGeneratedContext:
        'Fixed startup by treating absent local secrets as optional.',
      pullRequest: {
        provider: 'github' as const,
        host: 'github.com',
        repository: 'acme/web',
        number: 42,
        title: '[Fix] Keep the PR in the closeout',
        url: 'https://github.com/acme/web/pull/42',
        status: 'open' as const,
      },
    };
    mocks.answerQuestion.mockImplementation(
      async ({
        adapter,
      }: {
        adapter: { postReply: (reply: unknown) => unknown };
      }) =>
        adapter.postReply({
          purpose: 'closeout',
          message: 'The pull request is open.',
        }),
    );
    await deliverFastAgentParentEvent({
      parent,
      event: { ...pullRequestEvent, runId: 43 },
    });
    const firstClientMessageId =
      mocks.postMessage.mock.calls[0]?.[0]?.client_msg_id;
    await deliverFastAgentParentEvent({ parent, event: pullRequestEvent });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.stringContaining(
          pullRequestEvent.untrustedTaskGeneratedContext,
        ),
        turnSource: 'platform_event',
      }),
    );
    expect(firstClientMessageId).toEqual(expect.any(String));
    expect(mocks.postMessage.mock.calls[1]?.[0]?.client_msg_id).toBe(
      firstClientMessageId,
    );
    // The adapter hands back the posted message so the turn (or a run the
    // queue resumes) can edit it later, for example a retry notice that
    // becomes the answer.
    await expect(
      mocks.answerQuestion.mock.results.at(-1)!.value,
    ).resolves.toEqual({ messageId: '101.001' });
  });

  it('delivers pull request feedback as a platform event with a stable idempotency key', async () => {
    const superseded = {
      nonce: 'old-nonce',
      provider: 'slack',
      taskId: 'task-1',
      repository: 'acme/web',
      prNumber: 42,
      channelId: 'C123',
      threadId: '100.001',
      messageId: '99.001',
    };
    mocks.attachPendingPrReviewActionMessage.mockResolvedValueOnce({
      attached: true,
      superseded: [superseded],
    });
    const feedbackEvent = {
      type: 'pull_request_feedback' as const,
      feedbackId: 'feedback-123',
      taskId: 'task-1',
      runId: 42,
      taskUrl: 'https://roomote.example/task/task-1',
      pullRequest: {
        provider: 'github' as const,
        host: 'github.com',
        repository: 'acme/web',
        number: 42,
        title: 'Fix review feedback',
        url: 'https://github.com/acme/web/pull/42',
        status: 'open' as const,
      },
      summary: 'Alice requested changes.',
      suggestedActionQuestion: 'Want me to resolve these issues?',
      suggestedActionPrompt: 'Address the requested changes.',
    };
    mocks.answerQuestion.mockImplementation(
      async ({
        adapter,
      }: {
        adapter: { postReply: (reply: unknown) => unknown };
      }) =>
        adapter.postReply({
          purpose: 'closeout',
          message: 'There is new PR feedback.',
        }),
    );

    await deliverFastAgentParentEvent({ parent, event: feedbackEvent });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.stringContaining('"type":"pull_request_feedback"'),
        turnSource: 'platform_event',
        platformEventHandling: 'present_only',
        platformEventVisibility: 'required',
      }),
    );
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        client_msg_id: expect.any(String),
        text: 'There is new PR feedback.\nWant me to resolve these issues?',
        blocks: expect.arrayContaining([
          expect.objectContaining({ block_id: 'pr_review_action_question' }),
          expect.objectContaining({ type: 'actions' }),
        ]),
      }),
    );
    expect(mocks.setPendingPrReviewAction).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'slack',
        slackTeamId: 'T123',
        taskId: 'task-1',
        repository: 'acme/web',
        prNumber: 42,
        prUrl: 'https://github.com/acme/web/pull/42',
        channelId: 'C123',
        threadId: '100.001',
        followUpPrompt: 'Address the requested changes.',
        nonce: expect.any(String),
      }),
    );
    expect(mocks.attachPendingPrReviewActionMessage).toHaveBeenCalledWith(
      expect.any(String),
      '101.001',
    );
    expect(mocks.retirePrReviewActionMessagesBestEffort).toHaveBeenCalledWith([
      superseded,
    ]);
    expect(mocks.addReaction).not.toHaveBeenCalled();
  });

  it('delivers Discord pull request feedback with persisted inline actions', async () => {
    const feedbackEvent = {
      type: 'pull_request_feedback' as const,
      feedbackId: 'feedback-123',
      taskId: 'task-1',
      runId: 42,
      taskUrl: 'https://roomote.example/task/task-1',
      pullRequest: {
        provider: 'github' as const,
        host: 'github.com',
        repository: 'acme/web',
        number: 42,
        title: 'Fix review feedback',
        url: 'https://github.com/acme/web/pull/42',
        status: 'open' as const,
      },
      summary: 'Alice requested changes.',
      suggestedActionQuestion: 'Want me to resolve these issues?',
      suggestedActionPrompt: 'Address the requested changes.',
    };
    const discordParent = {
      ...parent,
      conversation: {
        surface: 'discord' as const,
        workspaceId: 'guild-1',
        conversationId: 'thread-1',
        replyTarget: { channelId: 'channel-1', threadId: 'thread-1' },
      },
    };
    mocks.answerQuestion.mockImplementation(
      async ({
        adapter,
      }: {
        adapter: { postReply: (reply: unknown) => unknown };
      }) =>
        adapter.postReply({
          purpose: 'closeout',
          message: 'There is new PR feedback.',
        }),
    );
    mocks.discordPostMessage.mockResolvedValueOnce({
      provider: 'discord',
      channelId: 'channel-1',
      threadId: 'thread-1',
      messageId: 'message-1',
      lastTextMessageId: 'message-with-actions',
    });

    await deliverFastAgentParentEvent({
      parent: discordParent,
      event: feedbackEvent,
    });

    expect(mocks.setPendingPrReviewAction).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'discord',
        taskId: 'task-1',
        repository: 'acme/web',
        prNumber: 42,
        prUrl: 'https://github.com/acme/web/pull/42',
        channelId: 'channel-1',
        threadId: 'thread-1',
        followUpPrompt: 'Address the requested changes.',
        nonce: expect.any(String),
      }),
    );
    const nonce = mocks.setPendingPrReviewAction.mock.calls[0]?.[0]?.nonce;
    expect(mocks.discordPostMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      threadId: 'thread-1',
      idempotencyKey: 'fast-parent-pr-feedback:feedback-123',
      text: expect.stringMatching(
        /^There is new PR feedback\.\nWant me to resolve these issues\?\n\n-# Working on \[PR #42\]\(https:\/\/github\.com\/acme\/web\/pull\/42\), reply or use the \[web app\]\(.*\/sessions\/.*\)\.$/,
      ),
      textFormat: 'markdown',
      images: [],
      buttons: [
        [
          {
            text: 'Resolve these issues',
            callbackData: `prr:y:${nonce}`,
          },
          {
            text: 'Auto-resolve on this PR',
            callbackData: `prr:a:${nonce}`,
          },
          { text: 'Dismiss', callbackData: `prr:d:${nonce}` },
        ],
      ],
    });
    expect(mocks.attachPendingPrReviewActionMessage).toHaveBeenCalledWith(
      nonce,
      'message-with-actions',
    );
  });

  it('preserves Discord action callbacks when attachment failure retries the post', async () => {
    const feedbackEvent = {
      type: 'pull_request_feedback' as const,
      feedbackId: 'feedback-retry',
      taskId: 'task-1',
      runId: 42,
      taskUrl: 'https://roomote.example/task/task-1',
      pullRequest: {
        provider: 'github' as const,
        host: 'github.com',
        repository: 'acme/web',
        number: 42,
        title: 'Fix review feedback',
        url: 'https://github.com/acme/web/pull/42',
        status: 'open' as const,
      },
      summary: 'Alice requested changes.',
      suggestedActionQuestion: 'Want me to resolve these issues?',
      suggestedActionPrompt: 'Address the requested changes.',
    };
    const discordParent = {
      ...parent,
      conversation: {
        surface: 'discord' as const,
        workspaceId: 'guild-1',
        conversationId: 'thread-1',
        replyTarget: { channelId: 'channel-1', threadId: 'thread-1' },
      },
    };
    mocks.answerQuestion.mockImplementation(
      async ({
        adapter,
      }: {
        adapter: { postReply: (reply: unknown) => unknown };
      }) =>
        adapter.postReply({
          purpose: 'closeout',
          message: 'There is new PR feedback.',
        }),
    );
    mocks.discordPostMessage.mockResolvedValue({
      provider: 'discord',
      channelId: 'channel-1',
      threadId: 'thread-1',
      messageId: 'message-with-actions',
    });
    mocks.attachPendingPrReviewActionMessage
      .mockRejectedValueOnce(new Error('attachment failed'))
      .mockResolvedValueOnce({ attached: true, superseded: [] });

    await expect(
      deliverFastAgentParentEvent({
        parent: discordParent,
        event: feedbackEvent,
      }),
    ).rejects.toThrow('attachment failed');
    await expect(
      deliverFastAgentParentEvent({
        parent: discordParent,
        event: feedbackEvent,
      }),
    ).resolves.toBe('delivered');

    const firstNonce = mocks.setPendingPrReviewAction.mock.calls[0]?.[0]?.nonce;
    const secondNonce =
      mocks.setPendingPrReviewAction.mock.calls[1]?.[0]?.nonce;
    expect(firstNonce).toEqual(expect.any(String));
    expect(secondNonce).toBe(firstNonce);
    expect(mocks.discordPostMessage.mock.calls[0]?.[0]?.buttons).toEqual(
      mocks.discordPostMessage.mock.calls[1]?.[0]?.buttons,
    );
    expect(mocks.attachPendingPrReviewActionMessage).toHaveBeenNthCalledWith(
      1,
      firstNonce,
      'message-with-actions',
    );
    expect(mocks.attachPendingPrReviewActionMessage).toHaveBeenNthCalledWith(
      2,
      firstNonce,
      'message-with-actions',
    );
  });

  it('delivers a pull request status event with a stable idempotency key', async () => {
    const statusEvent = {
      type: 'pull_request_status_changed' as const,
      taskId: 'task-1',
      runId: 42,
      taskUrl: 'https://roomote.example/task/task-1',
      pullRequest: {
        provider: 'github' as const,
        host: 'github.com',
        repository: 'acme/web',
        number: 42,
        title: 'Fix review feedback',
        url: 'https://github.com/acme/web/pull/42',
        targetBranch: 'develop',
        status: 'merged' as const,
      },
      status: 'merged' as const,
      actorLogin: 'alice',
    };
    mocks.answerQuestion.mockImplementation(
      async ({
        adapter,
      }: {
        adapter: { postReply: (reply: unknown) => unknown };
      }) =>
        adapter.postReply({
          purpose: 'closeout',
          message: 'The pull request was merged.',
        }),
    );

    await deliverFastAgentParentEvent({
      parent,
      event: { ...statusEvent, runId: 43 },
    });
    const firstClientMessageId =
      mocks.postMessage.mock.calls[0]?.[0]?.client_msg_id;
    await deliverFastAgentParentEvent({ parent, event: statusEvent });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.stringMatching(
          /"type":"pull_request_status_changed".*"targetBranch":"develop"/,
        ),
        turnSource: 'platform_event',
      }),
    );
    expect(mocks.answerQuestion.mock.calls[0]?.[0]?.question).not.toContain(
      '"targetBranch":"main"',
    );
    expect(firstClientMessageId).toEqual(expect.any(String));
    expect(mocks.postMessage.mock.calls[1]?.[0]?.client_msg_id).toBe(
      firstClientMessageId,
    );

    await deliverFastAgentParentEvent({
      parent,
      event: {
        ...statusEvent,
        status: 'closed',
        pullRequest: { ...statusEvent.pullRequest, status: 'closed' },
      },
    });

    expect(mocks.addReaction).toHaveBeenCalledTimes(2);
    expect(mocks.addReaction).toHaveBeenLastCalledWith({
      channel: 'C123',
      timestamp: '100.001',
      name: 'white_check_mark',
    });
  });

  it('adds the merge reaction when the Fast agent ignores the status event', async () => {
    mocks.answerQuestion.mockResolvedValue(undefined);

    await deliverFastAgentParentEvent({
      parent,
      event: {
        type: 'pull_request_status_changed',
        taskId: 'task-1',
        runId: 42,
        taskUrl: 'https://roomote.example/task/task-1',
        pullRequest: {
          provider: 'github',
          host: 'github.com',
          repository: 'acme/web',
          number: 42,
          title: 'Fix review feedback',
          url: 'https://github.com/acme/web/pull/42',
          status: 'merged',
        },
        status: 'merged',
        actorLogin: 'alice',
      },
    });

    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(mocks.addReaction).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: '100.001',
      name: 'white_check_mark',
    });
  });

  it('lets a settled task event re-query the remaining active task set', async () => {
    await deliverFastAgentParentEvent({
      parent,
      event: {
        type: 'task_settled',
        taskId: 'task-1',
        runId: 42,
        title: 'Fix API',
        status: 'completed',
        taskUrl: 'https://roomote.example/task/task-1',
        pullRequests: [],
      },
    });

    const input = mocks.answerQuestion.mock.calls[0]?.[0];
    expect(input).toEqual(
      expect.objectContaining({
        question: expect.stringContaining('"type":"task_settled"'),
        turnSource: 'platform_event',
      }),
    );
    expect(input).not.toHaveProperty('activeTasks');
  });

  it('skips a claimed pull request event that became terminal before delivery', async () => {
    mocks.findTaskRun.mockResolvedValueOnce({ status: 'completed' });
    const result = await deliverFastAgentParentEvent({
      parent,
      event: {
        type: 'pull_request_opened',
        taskId: 'task-1',
        runId: 42,
        taskUrl: 'https://roomote.example/task/task-1',
        pullRequest: {
          provider: 'github',
          host: 'github.com',
          repository: 'acme/web',
          number: 42,
          title: '[Fix] Keep the PR in the closeout',
          url: 'https://github.com/acme/web/pull/42',
          status: 'open',
        },
      },
    });

    expect(result).toBe('skipped');
    expect(mocks.answerQuestion).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(mocks.releaseTurnLock).toHaveBeenCalledOnce();
  });

  it('answers a pull request mention routed into a Slack Session on both the thread and the pull request', async () => {
    mocks.buildSourceControlFastDelivery.mockResolvedValue({
      postComment: async (input: unknown) => {
        mocks.postSourceControlComment(input);
        return { messageId: 'comment-1' };
      },
      resolveTarget: async () => ({
        repositoryId: 'repo-1',
        branch: 'feature/ship',
        pullRequest: { url: 'https://github.com/acme/api/pull/42' },
      }),
    });
    mocks.answerQuestion.mockImplementation(
      async ({
        adapter,
      }: {
        adapter: { postReply: (reply: unknown) => Promise<unknown> };
      }) => {
        await adapter.postReply({
          purpose: 'closeout',
          message: 'Done: the changelog now mentions the fix.',
        });
        return 'Done';
      },
    );

    await deliverFastAgentParentEventWithLock(
      {
        parent,
        event: {
          type: 'human_follow_up',
          eventId: 'github:comment:900',
          currentMessageId: 'github:comment:900',
          userId: 'user-2',
          question: 'Can you also update the changelog?',
          senderDisplayName: 'alice',
          agentContext: '<pull_request>#42</pull_request>',
          activeTasks: [{ taskId: 'task-owner', status: 'running' }],
          sourceControlReplyTarget: {
            provider: 'github',
            host: 'github.com',
            repositoryFullName: 'acme/api',
            kind: 'pull',
            number: 42,
            reviewCommentId: '800',
            url: 'https://github.com/acme/api/pull/42',
          },
        },
      },
      mocks.releaseTurnLock,
    );

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'Can you also update the changelog?',
        currentMessageAgentContext: '<pull_request>#42</pull_request>',
        activeTasks: [{ taskId: 'task-owner', status: 'running' }],
        turnSource: 'human',
      }),
    );
    expect(mocks.buildSourceControlFastDelivery).toHaveBeenCalledWith({
      surface: 'github',
      workspaceId: 'github.com/acme/api',
      conversationId: 'pull/42',
      replyTarget: { channelId: 'pull/42', threadId: '800' },
    });
    // The pull request gets the answer under the quoted mention, in the
    // review thread the mention came from.
    expect(mocks.postSourceControlComment).toHaveBeenCalledOnce();
    const comment = mocks.postSourceControlComment.mock.calls[0]?.[0] as {
      discussion: { number: number; reviewCommentId?: string };
      body: string;
    };
    expect(comment.discussion).toEqual(
      expect.objectContaining({ number: 42, reviewCommentId: '800' }),
    );
    expect(comment.body).toContain('> Can you also update the changelog?');
    expect(comment.body).toContain('Done: the changelog now mentions the fix.');
    // The Slack thread gets the same answer with attribution to the mention.
    const slackPosts = JSON.stringify(mocks.postMessage.mock.calls);
    expect(slackPosts).toContain(
      '**alice** on [acme/api#42](https://github.com/acme/api/pull/42):',
    );
    expect(slackPosts).toContain('Done: the changelog now mentions the fix.');
  });
});
