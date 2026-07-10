const {
  buildSlackRoutingContextMock,
  detectSlackMcpSetupRequirementMock,
  routeTaskMock,
  getTaskUrlMock,
  finishRoutedStartMock,
  mapRoutingWorkspaceToSelectionValueMock,
  resolveWorkspaceMock,
  startSlackAppMentionTaskMock,
  trackMock,
  trackAllMock,
  commitMock,
  findActiveSlackJobMock,
  trackSlackBotReplyMock,
  getSlackStartedMessageTsMock,
  setLatestSlackBotReplyMock,
} = vi.hoisted(() => ({
  buildSlackRoutingContextMock: vi.fn(),
  detectSlackMcpSetupRequirementMock: vi.fn(),
  routeTaskMock: vi.fn(),
  getTaskUrlMock: vi.fn(),
  finishRoutedStartMock: vi.fn(),
  mapRoutingWorkspaceToSelectionValueMock: vi.fn(),
  resolveWorkspaceMock: vi.fn(),
  startSlackAppMentionTaskMock: vi.fn(),
  trackMock: vi.fn(),
  trackAllMock: vi.fn(),
  commitMock: vi.fn(),
  findActiveSlackJobMock: vi.fn(),
  trackSlackBotReplyMock: vi.fn(),
  getSlackStartedMessageTsMock: vi.fn(),
  setLatestSlackBotReplyMock: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: {
    ROOMOTE_APP_URL: 'https://app.example.com',
    TRPC_URL: 'https://api.example.com',
  },
}));

vi.mock('@roomote/cloud-agents', () => ({
  appendAttachmentTextsToPromptText: vi.fn(
    (input: { text: string; attachmentTexts?: string[] }) =>
      [
        input.text.trim(),
        ...(input.attachmentTexts ?? []).filter(
          (attachmentText) => attachmentText.trim().length > 0,
        ),
      ]
        .filter(Boolean)
        .join('\n\n'),
  ),
  getSlackThreadDisplayName: vi.fn(
    (message: { user: string; username?: string }) =>
      message.username?.trim() || message.user,
  ),
  isRoomoteImageAttachment: vi.fn(
    (input: { filename?: string; mimeType?: string }) =>
      input.mimeType === 'image/png' ||
      input.mimeType === 'image/jpeg' ||
      input.mimeType === 'image/jpg' ||
      input.mimeType === 'image/gif' ||
      input.mimeType === 'image/webp' ||
      input.filename?.endsWith('.png') === true ||
      input.filename?.endsWith('.jpg') === true ||
      input.filename?.endsWith('.jpeg') === true ||
      input.filename?.endsWith('.gif') === true ||
      input.filename?.endsWith('.webp') === true,
  ),
  isRoomoteTextExtractableAttachment: vi.fn(
    (input: { filename?: string; mimeType?: string }) =>
      input.mimeType === 'application/pdf' ||
      input.mimeType?.startsWith('text/') === true ||
      input.filename?.endsWith('.txt') === true,
  ),
  stripLeadingRawSlackMention: vi.fn((text: string) => text),
  stripLeadingSlackProductMention: vi.fn((text: string) => text),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildSlackRoutingContext: buildSlackRoutingContextMock,
  detectSlackMcpSetupRequirement: detectSlackMcpSetupRequirementMock,
  routeTask: routeTaskMock,
  getTaskUrl: getTaskUrlMock,
}));

vi.mock('../block-kit', () => ({
  mapRoutingWorkspaceToSelectionValue: mapRoutingWorkspaceToSelectionValueMock,
  resolveWorkspace: resolveWorkspaceMock,
}));

vi.mock('../started-message', () => ({
  finishRoutedStart: finishRoutedStartMock,
}));

vi.mock('../start-slack-app-mention', () => ({
  startSlackAppMentionTask: startSlackAppMentionTaskMock,
}));

vi.mock('../slack-thread-delivery-tracker', () => ({
  SlackThreadDeliveryTracker: vi.fn().mockImplementation(function () {
    return {
      track: trackMock,
      trackAll: trackAllMock,
      commit: commitMock,
    };
  }),
}));

vi.mock('../find-active-slack-job', () => ({
  findActiveSlackJob: findActiveSlackJobMock,
}));

vi.mock('../slack-messages', () => ({
  getSlackStartedMessageTs: getSlackStartedMessageTsMock,
  setQueuedSlackStartedMessageTs: vi.fn(),
  trackSlackBotReply: trackSlackBotReplyMock,
  setLatestSlackBotReply: setLatestSlackBotReplyMock,
}));

import { startAutoRoutedSlackTask } from '../start-auto-routed-slack-task';

describe('startAutoRoutedSlackTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detectSlackMcpSetupRequirementMock.mockResolvedValue(null);
    buildSlackRoutingContextMock.mockResolvedValue({
      availableAgents: [{}],
      availableEnvironments: [{}],
    });
    routeTaskMock.mockResolvedValue({
      status: 'routed',
      result: {
        agentType: 'standard_task',
        workspace: { type: 'environment', id: 'env_1' },
        workspaceOnly: true,
        reasoning: 'Use App.',
        debug: {
          phase: 'direct',
          toolsUsed: [],
          needsExternalLookup: false,
          confidence: 0.97,
          workspaceRemapped: false,
        },
      },
    });
    mapRoutingWorkspaceToSelectionValueMock.mockReturnValue('env:env_1');
    resolveWorkspaceMock.mockResolvedValue({
      environmentId: 'env_1',
      repoForPayload: 'owner/repo',
      workspaceDisplayName: 'App',
    });
    startSlackAppMentionTaskMock.mockResolvedValue({
      id: 77,
      taskId: 'task_77',
      reusedExistingJob: false,
    });
    finishRoutedStartMock.mockResolvedValue(undefined);
    getTaskUrlMock.mockReturnValue('https://app.example.com/task/task_77');
    commitMock.mockResolvedValue(undefined);
    findActiveSlackJobMock.mockResolvedValue(null);
    getSlackStartedMessageTsMock.mockResolvedValue(null);
    trackSlackBotReplyMock.mockResolvedValue(undefined);
    setLatestSlackBotReplyMock.mockResolvedValue(undefined);
  });

  it('starts a routed Slack task with the provided launch identity', async () => {
    const slack = {
      hasMessageInThread: vi.fn().mockResolvedValue(true),
      getChannelName: vi.fn().mockResolvedValue('eng-routing'),
      normalizeIncomingText: vi
        .fn()
        .mockImplementation(async (text: string) => text),
      fetchThreadMessages: vi.fn().mockResolvedValue([
        {
          user: 'U123',
          text: 'Earlier context',
          ts: '120.000',
          type: 'message',
        },
        {
          user: 'USELECTED',
          text: 'Investigate this',
          ts: '123.456',
          type: 'message',
        },
        {
          user: 'UNEW',
          text: 'Newer reply',
          ts: '124.000',
          type: 'message',
        },
      ]),
    };

    const result = await startAutoRoutedSlackTask({
      slackInstallation: { orgId: 'org_1', botUserId: 'BROOMOTE' } as never,
      slack: slack as never,
      initiator: { kind: 'user' as const, userId: 'user_installer' },
      trigger: 'message' as const,
      launchUserId: 'user_installer',
      slackUserId: 'UINSTALLER',
      initiatingSlackUserId: 'UINSTALLER',
      channel: 'C123',
      prompt: 'Investigate this',
      threadTs: '120.000',
      originMessageTs: '123.456',
    });

    expect(slack.hasMessageInThread).toHaveBeenCalledWith({
      channel: 'C123',
      threadTs: '120.000',
      messageTs: '120.000',
    });
    expect(slack.fetchThreadMessages).toHaveBeenCalledWith({
      channel: 'C123',
      threadTs: '120.000',
    });
    expect(slack.getChannelName).toHaveBeenCalledWith('C123');
    expect(buildSlackRoutingContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_installer',
        taskDescription: 'Investigate this',
        channelName: 'eng-routing',
        threadMessages: [
          { text: 'Earlier context', user: 'U123' },
          { text: 'Investigate this', user: 'USELECTED' },
          { text: 'Newer reply', user: 'UNEW' },
        ],
      }),
    );
    expect(startSlackAppMentionTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator: { kind: 'user', userId: 'user_installer' },
        trigger: 'message',
        slackUserId: 'UINSTALLER',
        channel: 'C123',
        ts: '123.456',
        threadTs: '120.000',
        skipInitialActingUser: true,
        threadMessages: [
          {
            user: 'U123',
            text: 'Earlier context',
            ts: '120.000',
            type: 'message',
          },
          {
            user: 'USELECTED',
            text: 'Investigate this',
            ts: '123.456',
            type: 'message',
          },
          {
            user: 'UNEW',
            text: 'Newer reply',
            ts: '124.000',
            type: 'message',
          },
        ],
      }),
    );
    expect(finishRoutedStartMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJobId: 77,
        taskId: 'task_77',
        userId: 'user_installer',
        initiatingSlackUserId: 'UINSTALLER',
        workspaceDisplayName: 'App',
      }),
    );
    expect(trackMock).not.toHaveBeenCalled();
    expect(trackAllMock).toHaveBeenCalledWith([
      '120.000',
      '123.456',
      '124.000',
    ]);
    expect(commitMock).toHaveBeenCalled();
    expect(result).toEqual({
      status: 'started',
      threadId: '120.000',
      cloudJobId: 77,
      taskId: 'task_77',
      taskUrl: 'https://app.example.com/task/task_77',
    });
  });

  it('preserves the synthetic fallback ts when no origin message ts is provided', async () => {
    const slack = {
      hasMessageInThread: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi
        .fn()
        .mockImplementation(async (text: string) => text),
      fetchThreadMessages: vi.fn().mockResolvedValue([
        {
          user: 'U123',
          text: 'Earlier context',
          ts: '120.000',
          type: 'message',
        },
        {
          user: 'USELECTED',
          text: 'Investigate this',
          ts: '123.456',
          type: 'message',
        },
        {
          user: 'UNEW',
          text: 'Newer reply',
          ts: '124.000',
          type: 'message',
        },
      ]),
    };

    await startAutoRoutedSlackTask({
      slackInstallation: { orgId: 'org_1', botUserId: 'BROOMOTE' } as never,
      slack: slack as never,
      initiator: { kind: 'user' as const, userId: 'user_installer' },
      trigger: 'message' as const,
      launchUserId: 'user_installer',
      slackUserId: 'UINSTALLER',
      initiatingSlackUserId: 'UINSTALLER',
      channel: 'C123',
      prompt: 'Investigate this',
      threadTs: '120.000',
    });

    expect(startSlackAppMentionTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ts: '124.000001',
        threadTs: '120.000',
      }),
    );
  });

  it('prepends the injected channel prompt when provided', async () => {
    const slack = {
      hasMessageInThread: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi
        .fn()
        .mockImplementation(async (text: string) => text),
      fetchThreadMessages: vi.fn().mockResolvedValue([
        {
          user: 'USELECTED',
          text: 'Investigate this bug',
          ts: '120.000',
          type: 'message',
        },
      ]),
    };

    await startAutoRoutedSlackTask({
      slackInstallation: { orgId: 'org_1', botUserId: 'BROOMOTE' } as never,
      slack: slack as never,
      initiator: { kind: 'user' as const, userId: 'user_installer' },
      trigger: 'message' as const,
      launchUserId: 'user_installer',
      slackUserId: 'UINSTALLER',
      initiatingSlackUserId: 'UINSTALLER',
      channel: 'C123',
      prompt: 'Investigate this bug',
      threadTs: '120.000',
      agentPromptPrefix:
        'Treat each message as a bug report. Reproduce first and propose a fix.',
    });

    expect(startSlackAppMentionTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Investigate this bug',
        agentPromptText:
          'Treat each message as a bug report. Reproduce first and propose a fix.\n\nInvestigate this bug',
      }),
    );
  });

  it('passes video descriptions into routing context and launched task text', async () => {
    const slack = {
      hasMessageInThread: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi
        .fn()
        .mockImplementation(async (text: string) => text),
      fetchThreadMessages: vi.fn().mockResolvedValue([]),
    };

    await startAutoRoutedSlackTask({
      slackInstallation: { orgId: 'org_1' } as never,
      slack: slack as never,
      initiator: { kind: 'user' as const, userId: 'user_installer' },
      trigger: 'message' as const,
      launchUserId: 'user_installer',
      slackUserId: 'UINSTALLER',
      initiatingSlackUserId: 'UINSTALLER',
      channel: 'C123',
      prompt: 'Investigate this',
      threadTs: '120.000',
      processedVideoDescriptions: [
        'The user clicks Save and an inline validation error appears.',
      ],
    });

    expect(buildSlackRoutingContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        videoDescriptions: [
          'The user clicks Save and an inline validation error appears.',
        ],
      }),
    );
    expect(startSlackAppMentionTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Investigate this\n\nVideo attachment descriptions:\n- Video 1: The user clicks Save and an inline validation error appears.',
      }),
    );
    expect(finishRoutedStartMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskDescription:
          'Investigate this\n\nVideo attachment descriptions:\n- Video 1: The user clicks Save and an inline validation error appears.',
      }),
    );
  });

  it('filters the active started message out of payload context using its tracked timestamp', async () => {
    findActiveSlackJobMock.mockResolvedValue({ id: 77 });
    getSlackStartedMessageTsMock.mockResolvedValue('120.250');
    const slack = {
      hasMessageInThread: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi
        .fn()
        .mockImplementation(async (text: string) => text),
      fetchThreadMessages: vi.fn().mockResolvedValue([
        {
          user: 'U123',
          text: 'Earlier context',
          ts: '120.000',
          type: 'message',
        },
        {
          user: 'Ubot',
          username: 'Roomote Bot',
          text: 'System status message',
          ts: '120.250',
          type: 'message',
          bot_id: 'BROOMOTE',
        },
        {
          user: 'Uci',
          username: 'Deploy Bot',
          text: 'CI passed',
          ts: '120.300',
          type: 'message',
          bot_id: 'B_CI',
        },
        {
          user: 'USELECTED',
          text: 'Investigate this',
          ts: '123.456',
          type: 'message',
        },
      ]),
    };

    await startAutoRoutedSlackTask({
      slackInstallation: { orgId: 'org_1', botUserId: 'BROOMOTE' } as never,
      slack: slack as never,
      initiator: { kind: 'user' as const, userId: 'user_installer' },
      trigger: 'message' as const,
      launchUserId: 'user_installer',
      slackUserId: 'UINSTALLER',
      channel: 'C123',
      prompt: 'Investigate this',
      threadTs: '120.000',
    });

    expect(buildSlackRoutingContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadMessages: [
          { text: 'Earlier context', user: 'U123' },
          { text: 'CI passed', user: 'Uci' },
          { text: 'Investigate this', user: 'USELECTED' },
        ],
      }),
    );
    expect(startSlackAppMentionTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadMessages: [
          {
            user: 'U123',
            text: 'Earlier context',
            ts: '120.000',
            type: 'message',
          },
          {
            user: 'Uci',
            username: 'Deploy Bot',
            text: 'CI passed',
            ts: '120.300',
            type: 'message',
            bot_id: 'B_CI',
          },
          {
            user: 'USELECTED',
            text: 'Investigate this',
            ts: '123.456',
            type: 'message',
          },
        ],
        latestOwnBotReplyText: undefined,
        latestOwnBotReplyTs: undefined,
      }),
    );
    expect(trackAllMock).toHaveBeenCalledWith([
      '120.000',
      '120.300',
      '123.456',
    ]);
  });

  it('merges trigger-message images with older thread images in file-id order', async () => {
    const processSlackFiles = vi
      .fn()
      .mockResolvedValue(['thread-image-1', 'thread-image-2']);
    const slack = {
      hasMessageInThread: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi
        .fn()
        .mockImplementation(async (text: string) => text),
      processSlackFiles,
      fetchThreadMessages: vi.fn().mockResolvedValue([
        {
          user: 'U123',
          text: '',
          ts: '120.000',
          type: 'message',
          files: [
            {
              id: 'F-thread-1',
              name: 'thread-1.png',
              mimetype: 'image/png',
              filetype: 'png',
              url_private: 'https://files.slack.com/F-thread-1',
              url_private_download:
                'https://files.slack.com/F-thread-1/download',
              size: 1024,
            },
          ],
        },
        {
          user: 'U456',
          text: 'Screenshot two',
          ts: '121.000',
          type: 'message',
          files: [
            {
              id: 'F-thread-2',
              name: 'thread-2.jpg',
              mimetype: 'image/jpeg',
              filetype: 'jpg',
              url_private: 'https://files.slack.com/F-thread-2',
              url_private_download:
                'https://files.slack.com/F-thread-2/download',
              size: 2048,
            },
          ],
        },
        {
          user: 'USELECTED',
          text: 'Investigate this',
          ts: '123.456',
          type: 'message',
          files: [
            {
              id: 'F-current',
              name: 'current.png',
              mimetype: 'image/png',
              filetype: 'png',
              url_private: 'https://files.slack.com/F-current',
              url_private_download:
                'https://files.slack.com/F-current/download',
              size: 1024,
            },
          ],
        },
      ]),
    };

    await startAutoRoutedSlackTask({
      slackInstallation: { orgId: 'org_1' } as never,
      slack: slack as never,
      initiator: { kind: 'user' as const, userId: 'user_installer' },
      trigger: 'message' as const,
      launchUserId: 'user_installer',
      slackUserId: 'UINSTALLER',
      channel: 'C123',
      prompt: 'Investigate this',
      threadTs: '120.000',
      processedImages: ['current-image'],
      processedImageFileIds: ['F-current'],
    });

    expect(processSlackFiles).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'F-thread-1' }),
      expect.objectContaining({ id: 'F-thread-2' }),
    ]);
    expect(buildSlackRoutingContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        images: ['current-image', 'thread-image-1', 'thread-image-2'],
      }),
    );
    expect(startSlackAppMentionTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        images: ['current-image', 'thread-image-1', 'thread-image-2'],
      }),
    );
  });

  it('deduplicates repeated thread file ids before downloading images', async () => {
    const processSlackFiles = vi.fn().mockResolvedValue(['thread-image']);
    const slack = {
      hasMessageInThread: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi
        .fn()
        .mockImplementation(async (text: string) => text),
      processSlackFiles,
      fetchThreadMessages: vi.fn().mockResolvedValue([
        {
          user: 'U123',
          text: 'First copy',
          ts: '120.000',
          type: 'message',
          files: [
            {
              id: 'F-dup',
              name: 'dup.png',
              mimetype: 'image/png',
              filetype: 'png',
              url_private: 'https://files.slack.com/F-dup',
              url_private_download: 'https://files.slack.com/F-dup/download',
              size: 1024,
            },
          ],
        },
        {
          user: 'U456',
          text: 'Second copy',
          ts: '121.000',
          type: 'message',
          files: [
            {
              id: 'F-dup',
              name: 'dup-again.png',
              mimetype: 'image/png',
              filetype: 'png',
              url_private: 'https://files.slack.com/F-dup',
              url_private_download: 'https://files.slack.com/F-dup/download',
              size: 1024,
            },
          ],
        },
      ]),
    };

    await startAutoRoutedSlackTask({
      slackInstallation: { orgId: 'org_1' } as never,
      slack: slack as never,
      initiator: { kind: 'user' as const, userId: 'user_installer' },
      trigger: 'message' as const,
      launchUserId: 'user_installer',
      slackUserId: 'UINSTALLER',
      channel: 'C123',
      prompt: 'Investigate this',
      threadTs: '120.000',
    });

    expect(processSlackFiles).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'F-dup' }),
    ]);
  });

  it('filters non-image thread files before downloading them', async () => {
    const processSlackFiles = vi.fn().mockResolvedValue(['thread-image']);
    const slack = {
      hasMessageInThread: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi
        .fn()
        .mockImplementation(async (text: string) => text),
      processSlackFiles,
      fetchThreadMessages: vi.fn().mockResolvedValue([
        {
          user: 'U123',
          text: 'Files attached',
          ts: '120.000',
          type: 'message',
          files: [
            {
              id: 'F-pdf',
              name: 'spec.pdf',
              mimetype: 'application/pdf',
              filetype: 'pdf',
              url_private: 'https://files.slack.com/F-pdf',
              url_private_download: 'https://files.slack.com/F-pdf/download',
              size: 1024,
            },
            {
              id: 'F-image',
              name: 'shot.png',
              mimetype: 'image/png',
              filetype: 'png',
              url_private: 'https://files.slack.com/F-image',
              url_private_download: 'https://files.slack.com/F-image/download',
              size: 1024,
            },
          ],
        },
      ]),
    };

    await startAutoRoutedSlackTask({
      slackInstallation: { orgId: 'org_1' } as never,
      slack: slack as never,
      initiator: { kind: 'user' as const, userId: 'user_installer' },
      trigger: 'message' as const,
      launchUserId: 'user_installer',
      slackUserId: 'UINSTALLER',
      channel: 'C123',
      prompt: 'Investigate this',
      threadTs: '120.000',
    });

    expect(processSlackFiles).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'F-image' }),
    ]);
  });

  it('does not re-extract already processed root text attachments', async () => {
    const downloadSlackFile = vi.fn();
    const slack = {
      hasMessageInThread: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi
        .fn()
        .mockImplementation(async (text: string) => text),
      downloadSlackFile,
      fetchThreadMessages: vi.fn().mockResolvedValue([
        {
          user: 'USELECTED',
          text: 'Investigate this',
          ts: '120.000',
          type: 'message',
          files: [
            {
              id: 'F-root-pdf',
              name: 'root.pdf',
              mimetype: 'application/pdf',
              filetype: 'pdf',
              url_private: 'https://files.slack.com/F-root-pdf',
              url_private_download:
                'https://files.slack.com/F-root-pdf/download',
              size: 1024,
            },
          ],
        },
      ]),
    };

    await startAutoRoutedSlackTask({
      slackInstallation: { orgId: 'org_1' } as never,
      slack: slack as never,
      initiator: { kind: 'user' as const, userId: 'user_installer' },
      trigger: 'message' as const,
      launchUserId: 'user_installer',
      slackUserId: 'UINSTALLER',
      channel: 'C123',
      prompt: 'Investigate this',
      threadTs: '120.000',
      processedAttachmentTexts: ['Extracted root file text'],
      processedAttachmentFileIds: ['F-root-pdf'],
    });

    expect(downloadSlackFile).not.toHaveBeenCalled();
    expect(buildSlackRoutingContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskDescription: 'Investigate this\n\nExtracted root file text',
      }),
    );
    expect(startSlackAppMentionTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Investigate this\n\nExtracted root file text',
      }),
    );
  });

  it('starts a routed Slack task without an existing thread by seeding a new root message', async () => {
    const slack = {
      normalizeIncomingText: vi
        .fn()
        .mockImplementation(async (text: string) => text),
      fetchThreadMessages: vi.fn(),
      postMessage: vi.fn().mockResolvedValue('555.000'),
    };

    const result = await startAutoRoutedSlackTask({
      slackInstallation: { orgId: 'org_1' } as never,
      slack: slack as never,
      initiator: { kind: 'user' as const, userId: 'user_installer' },
      trigger: 'message' as const,
      launchUserId: 'user_installer',
      slackUserId: 'UINSTALLER',
      initiatingSlackUserId: 'UINSTALLER',
      channel: 'C123',
      prompt: 'Investigate this',
    });

    expect(slack.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      text: 'Roomote is starting your task...',
    });
    expect(startSlackAppMentionTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator: { kind: 'user', userId: 'user_installer' },
        trigger: 'message',
        slackUserId: 'UINSTALLER',
        channel: 'C123',
        ts: '555.000',
        threadTs: '555.000',
        skipInitialActingUser: true,
      }),
    );
    expect(finishRoutedStartMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: '555.000',
        existingMessageTs: '555.000',
      }),
    );
    expect(trackMock).toHaveBeenCalledWith('555.000');
    expect(result).toEqual({
      status: 'started',
      threadId: '555.000',
      cloudJobId: 77,
      taskId: 'task_77',
      taskUrl: 'https://app.example.com/task/task_77',
    });
    expect(commitMock).toHaveBeenCalled();
  });

  it('constrains routing by repository and forwards launch overrides', async () => {
    buildSlackRoutingContextMock.mockResolvedValueOnce({
      availableAgents: [{}],
      availableEnvironments: [
        {
          id: 'env_1',
          name: 'App',
          repositoryNames: ['acme/app'],
        },
        {
          id: 'env_2',
          name: 'Worker',
          repositoryNames: ['acme/worker'],
        },
      ],
    });
    routeTaskMock.mockResolvedValueOnce({
      status: 'routed',
      result: {
        agentType: 'standard_task',
        workspace: { type: 'environment', id: 'env_2' },
        workspaceOnly: true,
        reasoning: 'Use Worker.',
        debug: {
          phase: 'direct',
          toolsUsed: [],
          needsExternalLookup: false,
          confidence: 0.92,
          workspaceRemapped: false,
        },
      },
    });
    mapRoutingWorkspaceToSelectionValueMock.mockReturnValueOnce('env:env_2');
    resolveWorkspaceMock.mockResolvedValueOnce({
      environmentId: 'env_2',
      repoForPayload: 'owner/worker',
      workspaceDisplayName: 'Worker',
    });

    const slack = {
      hasMessageInThread: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi
        .fn()
        .mockImplementation(async (text: string) => text),
      fetchThreadMessages: vi.fn().mockResolvedValue([]),
    };

    await startAutoRoutedSlackTask({
      slackInstallation: {
        botUserId: 'BROOMOTE',
        teamId: 'T123',
      } as never,
      slack: slack as never,
      initiator: { kind: 'user' as const, userId: 'user_installer' },
      trigger: 'message' as const,
      launchUserId: 'user_installer',
      slackUserId: 'UINSTALLER',
      channel: 'C123',
      prompt: 'Investigate worker retries',
      threadTs: '120.000',
      originMessageTs: '120.000',
      agentPromptTextOverride: 'Use the saved suggestion prompt.',
      ackEmoji: 'eyes',
      completionEmoji: 'white_check_mark',
      routingRepositoryConstraint: 'acme/worker',
      webPath: '/setup',
    });

    expect(routeTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        availableEnvironments: [
          {
            id: 'env_2',
            name: 'Worker',
            repositoryNames: ['acme/worker'],
          },
        ],
      }),
    );
    expect(startSlackAppMentionTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPromptText: 'Use the saved suggestion prompt.',
        ackEmoji: 'eyes',
        completionEmoji: 'white_check_mark',
        webPath: '/setup',
      }),
    );
  });

  it('does not post a fresh started state when the helper reuses an active job', async () => {
    const slack = {
      hasMessageInThread: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi
        .fn()
        .mockImplementation(async (text: string) => text),
      fetchThreadMessages: vi.fn().mockResolvedValue([]),
    };
    startSlackAppMentionTaskMock.mockResolvedValueOnce({
      id: 88,
      taskId: 'task_existing',
      reusedExistingJob: true,
    });
    getTaskUrlMock.mockReturnValueOnce(
      'https://app.example.com/task/task_existing',
    );

    const result = await startAutoRoutedSlackTask({
      slackInstallation: { orgId: 'org_1' } as never,
      slack: slack as never,
      initiator: { kind: 'user' as const, userId: 'user_installer' },
      trigger: 'message' as const,
      launchUserId: 'user_installer',
      slackUserId: 'UINSTALLER',
      initiatingSlackUserId: 'UINSTALLER',
      channel: 'C123',
      prompt: 'Investigate this',
      threadTs: '120.000',
    });

    expect(finishRoutedStartMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'started',
      threadId: '120.000',
      cloudJobId: 88,
      taskId: 'task_existing',
      taskUrl: 'https://app.example.com/task/task_existing',
    });
  });

  it('continues starting when thread verification is temporarily unavailable', async () => {
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    try {
      const slack = {
        hasMessageInThread: vi.fn().mockResolvedValue(null),
        isAppInChannel: vi.fn().mockResolvedValue(true),
        normalizeIncomingText: vi
          .fn()
          .mockImplementation(async (text: string) => text),
        fetchThreadMessages: vi
          .fn()
          .mockRejectedValue(new Error('Slack unavailable')),
      };

      const result = await startAutoRoutedSlackTask({
        slackInstallation: { orgId: 'org_1', botUserId: 'BROOMOTE' } as never,
        slack: slack as never,
        initiator: { kind: 'user' as const, userId: 'user_installer' },
        trigger: 'message' as const,
        launchUserId: 'user_installer',
        slackUserId: 'UINSTALLER',
        channel: 'C123',
        prompt: 'Investigate this',
        threadTs: '123.456',
      });

      expect(result).toEqual({
        status: 'started',
        threadId: '123.456',
        cloudJobId: 77,
        taskId: 'task_77',
        taskUrl: 'https://app.example.com/task/task_77',
      });
      expect(detectSlackMcpSetupRequirementMock).toHaveBeenCalled();
      expect(routeTaskMock).toHaveBeenCalled();
      expect(startSlackAppMentionTaskMock).toHaveBeenCalled();
      expect(slack.isAppInChannel).toHaveBeenCalledWith('C123');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[startAutoRoutedSlackTask] Could not verify access to Slack thread C123:123.456; continuing without blocking task launch',
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[startAutoRoutedSlackTask] Failed to fetch thread messages for C123:123.456: Slack unavailable',
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('refuses to start when thread verification fails and Roomote is not in the channel', async () => {
    const slack = {
      hasMessageInThread: vi.fn().mockResolvedValue(null),
      isAppInChannel: vi.fn().mockResolvedValue(false),
      normalizeIncomingText: vi.fn(),
      fetchThreadMessages: vi.fn(),
    };

    const result = await startAutoRoutedSlackTask({
      slackInstallation: { orgId: 'org_1' } as never,
      slack: slack as never,
      initiator: { kind: 'user' as const, userId: 'user_installer' },
      trigger: 'message' as const,
      launchUserId: 'user_installer',
      slackUserId: 'UINSTALLER',
      channel: 'C123',
      prompt: 'Investigate this',
      threadTs: '123.456',
    });

    expect(result).toEqual({
      status: 'not_started',
      code: 'source_message_inaccessible',
      threadId: '123.456',
      message:
        'Roomote could not access the target Slack thread. Make sure the Roomote app is still in that channel and try again.',
    });
    expect(slack.isAppInChannel).toHaveBeenCalledWith('C123');
    expect(detectSlackMcpSetupRequirementMock).not.toHaveBeenCalled();
    expect(routeTaskMock).not.toHaveBeenCalled();
    expect(startSlackAppMentionTaskMock).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('omits cancel ownership when no initiating Slack user is provided', async () => {
    const slack = {
      hasMessageInThread: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi
        .fn()
        .mockImplementation(async (text: string) => text),
      fetchThreadMessages: vi.fn().mockResolvedValue([]),
    };

    await startAutoRoutedSlackTask({
      slackInstallation: { orgId: 'org_1' } as never,
      slack: slack as never,
      initiator: { kind: 'user' as const, userId: 'user_installer' },
      trigger: 'message' as const,
      launchUserId: 'user_installer',
      slackUserId: 'U_BOT',
      channel: 'C123',
      prompt: 'Investigate this',
      threadTs: '120.000',
    });

    expect(finishRoutedStartMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initiatingSlackUserId: undefined,
      }),
    );
  });

  it('can omit the persisted Slack thread owner while still launching with an installer identity', async () => {
    const slack = {
      hasMessageInThread: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi
        .fn()
        .mockImplementation(async (text: string) => text),
      fetchThreadMessages: vi.fn().mockResolvedValue([]),
    };

    await startAutoRoutedSlackTask({
      slackInstallation: { orgId: 'org_1', botUserId: 'U_BOT' } as never,
      slack: slack as never,
      initiator: { kind: 'user' as const, userId: 'user_installer' },
      trigger: 'message' as const,
      launchUserId: 'user_installer',
      slackUserId: 'UINSTALLER',
      persistedSlackUserId: null,
      initiatingSlackUserId: 'UINSTALLER',
      channel: 'C123',
      prompt: 'Investigate this alert',
      threadTs: '120.000',
    });

    expect(startSlackAppMentionTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator: { kind: 'user', userId: 'user_installer' },
        trigger: 'message',
        slackUserId: 'UINSTALLER',
        persistedSlackUserId: null,
      }),
    );
  });

  it('bypasses the MCP setup blocker when requested for automated launches', async () => {
    detectSlackMcpSetupRequirementMock.mockResolvedValue({
      serviceId: 'linear',
      serviceName: 'Linear',
      reason: 'user_auth_required',
      canConfigure: true,
      settingsUrl: 'https://app.example.com/settings/personal?service=linear',
      copyVariant: 'user_auth_required',
    });

    const slack = {
      hasMessageInThread: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi
        .fn()
        .mockImplementation(async (text: string) => text),
      fetchThreadMessages: vi.fn().mockResolvedValue([]),
    };

    const result = await startAutoRoutedSlackTask({
      slackInstallation: { orgId: 'org_1' } as never,
      slack: slack as never,
      initiator: { kind: 'user' as const, userId: 'user_installer' },
      trigger: 'message' as const,
      launchUserId: 'user_installer',
      slackUserId: 'UINSTALLER',
      channel: 'C123',
      prompt: 'Investigate https://linear.app/acme/issue/OPS-123',
      threadTs: '120.000',
      skipMcpSetupInterrupt: true,
    });

    expect(detectSlackMcpSetupRequirementMock).not.toHaveBeenCalled();
    expect(routeTaskMock).toHaveBeenCalled();
    expect(startSlackAppMentionTaskMock).toHaveBeenCalled();
    expect(result).toEqual({
      status: 'started',
      threadId: '120.000',
      cloudJobId: 77,
      taskId: 'task_77',
      taskUrl: 'https://app.example.com/task/task_77',
    });
  });
});
