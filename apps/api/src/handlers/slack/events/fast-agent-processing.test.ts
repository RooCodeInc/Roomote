const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  acquireRootBindingLock: vi.fn(),
  hasSession: vi.fn(),
  releaseLock: vi.fn(),
  releaseRootBindingLock: vi.fn(),
  answerQuestion: vi.fn(),
  findConversation: vi.fn(),
  getSession: vi.fn(),
  postThreadMessage: vi.fn(),
  recordProviderMessage: vi.fn(),
  listCommunicationChannels: vi.fn(),
  sendCommunicationChannelPost: vi.fn(),
}));

vi.mock('@roomote/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/redis')>();
  return {
    ...actual,
    // The sticky-footer state lives in Redis; unit tests run without a
    // server (a real client would wait on commands forever), so serve
    // empty state.
    getRedis: () => ({
      set: async () => 'OK',
      get: async () => null,
      eval: async () => 1,
    }),
  };
});

vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireLock,
  answerFastAgentQuestion: mocks.answerQuestion,
  fastAgentConversationRepository: { findById: mocks.findConversation },
  extractPromptTextAttachments: vi.fn(
    async (inputs: Array<{ filename: string; bytes: Uint8Array }>) => ({
      attachmentTexts: inputs.map(
        (input) =>
          `Attachment: ${input.filename}\n${Buffer.from(input.bytes).toString('utf8')}`,
      ),
      warnings: [],
    }),
  ),
  hasFastAgentSession: mocks.hasSession,
  getOrCreateFastAgentSession: mocks.getSession,
}));

vi.mock('@roomote/slack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/slack')>()),
  acquireSlackFastRootBindingLock: mocks.acquireRootBindingLock,
}));

vi.mock('@roomote/cloud-agents', () => ({
  appendAttachmentTextsToPromptText: ({
    text,
    attachmentTexts = [],
  }: {
    text: string;
    attachmentTexts?: string[];
  }) => [text, ...attachmentTexts].filter(Boolean).join('\n\n'),
  isRoomoteTextExtractableAttachment: ({ mimeType }: { mimeType?: string }) =>
    mimeType?.startsWith('text/') ?? false,
  stripLeadingSlackProductMention: (text: string) => text,
}));

vi.mock('@roomote/sdk/server', () => ({
  recordFastAgentConversationMessageBestEffort: mocks.recordProviderMessage,
  resolveUserMcpServerConfigs: vi.fn(async () => ({})),
}));

vi.mock('@roomote/communication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/communication')>()),
  resolveFastSessionReplyFooterContext: vi.fn(async () => ({
    linkedPrs: [],
    livePreviewUrl: null,
  })),
}));

vi.mock('../helpers/thread-posting.js', () => ({
  postSlackThreadMarkdownMessage: mocks.postThreadMessage,
}));

vi.mock('../../mcp/communication-channel-discovery.js', () => ({
  listCommunicationChannels: mocks.listCommunicationChannels,
}));

vi.mock('../../mcp/communication-channel-posts.js', () => ({
  sendCommunicationChannelPost: mocks.sendCommunicationChannelPost,
}));

import { processFastAgentMessage as processFastAgentMessageImpl } from './fast-agent.js';

type ProcessFastAgentMessageParams = Parameters<
  typeof processFastAgentMessageImpl
>[0];
const launchTask = vi.fn();
const processFastAgentMessage = (
  params: Omit<ProcessFastAgentMessageParams, 'launchTask'>,
) => processFastAgentMessageImpl({ ...params, launchTask });

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('processFastAgentMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireLock.mockResolvedValue(mocks.releaseLock);
    mocks.acquireRootBindingLock.mockResolvedValue(
      mocks.releaseRootBindingLock,
    );
    mocks.hasSession.mockResolvedValue(false);
    mocks.getSession.mockImplementation(
      async ({ conversation }: { conversation: unknown }) => ({
        id: 'fast-session-1',
        conversation,
      }),
    );
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.releaseRootBindingLock.mockResolvedValue(undefined);
    mocks.postThreadMessage.mockResolvedValue({
      status: 'posted',
      messageId: '101.001',
    });
    mocks.recordProviderMessage.mockResolvedValue(undefined);
    mocks.listCommunicationChannels.mockResolvedValue({ channelCount: 0 });
    mocks.sendCommunicationChannelPost.mockResolvedValue(
      Response.json({ channelId: 'C456', messageTs: '200.001' }),
    );
    mocks.answerQuestion.mockImplementation(
      async ({
        adapter,
      }: {
        adapter: { postReply: (reply: unknown) => void };
      }) => {
        await adapter.postReply({
          purpose: 'closeout',
          message: 'Doing well.',
        });
        return 'Doing well.';
      },
    );
  });

  it('replaces a Fast retry notice in place', async () => {
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => []),
      updateMessage: vi.fn().mockResolvedValue(true),
    };
    mocks.answerQuestion.mockImplementationOnce(
      async ({
        adapter,
      }: {
        adapter: {
          postReply: (reply: unknown) => Promise<{ messageId: string }>;
          replaceReply: (
            handle: { messageId: string },
            reply: unknown,
          ) => Promise<{ messageId: string }>;
        };
      }) => {
        const handle = await adapter.postReply({
          purpose: 'progress',
          message: 'Retrying connection to the inference provider.',
        });
        await adapter.replaceReply(handle, {
          purpose: 'closeout',
          message: 'Connection restored.',
        });
        return 'Connection restored.';
      },
    );

    await processFastAgentMessage({
      event: {
        type: 'message',
        channel: 'D123',
        user: 'U123',
        text: '!fast investigate this',
        ts: '100.001',
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
    });

    expect(mocks.postThreadMessage).toHaveBeenCalledOnce();
    expect(mocks.recordProviderMessage).toHaveBeenCalledWith({
      sessionId: 'fast-session-1',
      conversation: {
        surface: 'slack',
        workspaceId: 'T123',
        conversationId: '100.001',
        replyTarget: { channelId: 'D123', threadId: '100.001' },
      },
      messageId: '101.001',
    });
    expect(slack.updateMessage).toHaveBeenCalledWith({
      channel: 'D123',
      ts: '101.001',
      message: {
        text: 'Connection restored.',
        blocks: [{ type: 'markdown', text: 'Connection restored.' }],
      },
    });
  });

  it('keeps injected Slack context separate from the Fast question', async () => {
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => []),
    };

    await processFastAgentMessage({
      event: {
        type: 'message',
        channel: 'D123',
        user: 'U123',
        authoredText: '!fast investigate this',
        agentContext: 'Slack block text:\nState: New',
        text: '!fast investigate this\n\nSlack block text:\nState: New',
        ts: '100.001',
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
      roomoteSlackUserId: 'UROOMOTE',
      activeTasks: [
        { taskId: 'task-1', title: 'Fix API' },
        { taskId: 'task-2', title: 'Update docs' },
      ],
    });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'investigate this',
        slackRoomoteUserId: 'UROOMOTE',
        currentMessageAgentContext: 'Slack block text:\nState: New',
        adapter: expect.objectContaining({ launchTask }),
        activeTasks: [
          { taskId: 'task-1', title: 'Fix API' },
          { taskId: 'task-2', title: 'Update docs' },
        ],
      }),
    );
  });

  it('binds Fast channel tools to the acting user and Slack workspace', async () => {
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => []),
    };
    mocks.answerQuestion.mockImplementationOnce(
      async ({
        adapter,
      }: {
        adapter: {
          listChatChannels: () => Promise<unknown>;
          postToChannel: (params: {
            channel: string;
            threadTs?: string;
            text: string;
          }) => Promise<unknown>;
        };
      }) => {
        await adapter.listChatChannels();
        await adapter.postToChannel({
          channel: '#shipping',
          threadTs: '199.001',
          text: 'Release is ready.',
        });
        return 'Posted.';
      },
    );

    await processFastAgentMessage({
      event: {
        type: 'message',
        channel: 'C123',
        user: 'U123',
        text: '!fast post the release update',
        thread_ts: '100.001',
        ts: '100.002',
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
    });

    expect(mocks.listCommunicationChannels).toHaveBeenCalledWith({
      actingUserId: 'user-1',
      slackTeamId: 'T123',
    });
    expect(mocks.sendCommunicationChannelPost).toHaveBeenCalledWith({
      taskRun: {
        id: 0,
        taskId: 'fast-session-1',
        actingUserId: 'user-1',
        payload: {
          communicationProvider: 'slack',
          communicationTeamId: 'T123',
          communicationChannelId: 'C123',
          communicationThreadId: '100.001',
        },
      },
      parsedBody: {
        channel: '#shipping',
        threadTs: '199.001',
        text: 'Release is ready.',
        images: [],
      },
    });
  });

  it('resumes the canonical Fast session bound to a delayed Slack root', async () => {
    const canonicalConversation = {
      surface: 'slack' as const,
      workspaceId: 'T123',
      conversationId: 'automation-1:occurrence-1',
      replyTarget: { channelId: 'C123', threadId: '100.001' },
    };
    mocks.hasSession.mockResolvedValue(true);
    mocks.getSession.mockResolvedValue({
      id: 'fast-session-1',
      conversation: canonicalConversation,
    });
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => []),
    };

    await processFastAgentMessage({
      event: {
        type: 'message',
        channel: 'C123',
        user: 'U123',
        text: 'continue',
        thread_ts: '100.001',
        ts: '100.002',
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
      continuation: true,
    });

    expect(mocks.acquireLock).toHaveBeenCalledWith({
      conversation: canonicalConversation,
    });
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ conversation: canonicalConversation }),
    );
  });

  it('waits for root binding before resolving an immediate reply session', async () => {
    const bindingLock = createDeferred<() => Promise<void>>();
    mocks.acquireRootBindingLock.mockReturnValueOnce(bindingLock.promise);
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => []),
    };

    const processing = processFastAgentMessage({
      event: {
        type: 'message',
        channel: 'C123',
        user: 'U123',
        text: 'continue',
        thread_ts: '100.001',
        ts: '100.002',
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
      continuation: true,
    });

    await vi.waitFor(() => {
      expect(mocks.acquireRootBindingLock).toHaveBeenCalledOnce();
    });
    expect(mocks.getSession).not.toHaveBeenCalled();

    bindingLock.resolve(mocks.releaseRootBindingLock);
    await processing;

    expect(mocks.getSession).toHaveBeenCalledOnce();
  });

  it('lets the Fast model answer a bare !fast invocation', async () => {
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => []),
    };

    await processFastAgentMessage({
      event: {
        type: 'message',
        channel: 'D123',
        user: 'U123',
        text: '!fast',
        ts: '100.001',
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
    });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ question: '' }),
    );
    expect(mocks.postThreadMessage).toHaveBeenCalledOnce();
    expect(mocks.postThreadMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Doing well.' }),
    );
  });

  it('lets the Fast model answer an empty default-mode invocation', async () => {
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => []),
    };

    await processFastAgentMessage({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '',
        ts: '100.001',
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
      continuation: true,
    });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ question: '' }),
    );
    expect(mocks.postThreadMessage).toHaveBeenCalledOnce();
    expect(mocks.postThreadMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Doing well.' }),
    );
  });

  it('resolves pending reply tasks only after acquiring the Fast turn lock', async () => {
    const resolveActiveTasks = vi
      .fn()
      .mockResolvedValue([{ taskId: 'review-task' }]);
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => []),
    };

    await processFastAgentMessage({
      event: {
        type: 'message',
        channel: 'C123',
        user: 'U123',
        text: 'resolve this issue',
        thread_ts: '100.001',
        ts: '100.002',
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
      continuation: true,
      resolveActiveTasks,
    });

    expect(mocks.acquireLock.mock.invocationCallOrder[0]).toBeLessThan(
      resolveActiveTasks.mock.invocationCallOrder[0] as number,
    );
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'resolve this issue',
        activeTasks: [{ taskId: 'review-task' }],
      }),
    );
  });

  it('passes an image from the initial Slack message to the Fast model', async () => {
    const image = 'data:image/png;base64,aW5pdGlhbA==';
    const files = [
      {
        id: 'F_INITIAL',
        name: 'initial.png',
        mimetype: 'image/png',
        filetype: 'png',
        url_private: 'https://files.slack.com/F_INITIAL',
        url_private_download: 'https://files.slack.com/F_INITIAL/download',
        size: 1024,
      },
    ];
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => [
        {
          user: 'U123',
          text: '!fast inspect this screenshot',
          ts: '100.001',
          type: 'message',
          files,
        },
      ]),
      processSlackFiles: vi.fn().mockResolvedValue([image]),
    };

    await processFastAgentMessage({
      event: {
        type: 'message',
        channel: 'D123',
        channel_type: 'im',
        user: 'U123',
        text: '!fast inspect this screenshot',
        ts: '100.001',
        files,
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
    });

    expect(slack.processSlackFiles).toHaveBeenCalledWith(files);
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ images: [image] }),
    );
  });

  it('passes an image from a subsequent Slack thread message to the Fast model', async () => {
    const image = 'data:image/jpeg;base64,Zm9sbG93LXVw';
    const files = [
      {
        id: 'F_FOLLOW_UP',
        name: 'follow-up.jpg',
        mimetype: 'image/jpeg',
        filetype: 'jpg',
        url_private: 'https://files.slack.com/F_FOLLOW_UP',
        url_private_download: 'https://files.slack.com/F_FOLLOW_UP/download',
        size: 2048,
      },
    ];
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => [
        {
          user: 'U123',
          text: '!fast inspect this screenshot',
          ts: '100.001',
          type: 'message',
        },
        {
          user: 'U123',
          text: 'What about this one?',
          ts: '100.002',
          type: 'message',
          files,
        },
      ]),
      processSlackFiles: vi.fn().mockResolvedValue([image]),
    };

    await processFastAgentMessage({
      event: {
        type: 'message',
        channel: 'D123',
        channel_type: 'im',
        thread_ts: '100.001',
        user: 'U123',
        text: 'What about this one?',
        ts: '100.002',
        files,
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
      continuation: true,
    });

    expect(slack.processSlackFiles).toHaveBeenCalledWith(files);
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'What about this one?',
        images: [image],
      }),
    );
  });

  it('passes authenticated extracted file content to the Fast turn separately', async () => {
    const files = [
      {
        id: 'F_PLAN',
        name: 'plan.md',
        mimetype: 'text/markdown',
        filetype: 'markdown',
        url_private: 'https://files.slack.com/F_PLAN',
        url_private_download: 'https://files.slack.com/F_PLAN/download',
        size: 128,
      },
    ];
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => []),
      processSlackFiles: vi.fn().mockResolvedValue([]),
      downloadSlackFile: vi
        .fn()
        .mockResolvedValue(
          Buffer.from('# Plan\nImplement attachment forwarding.'),
        ),
    };

    await processFastAgentMessage({
      event: {
        type: 'message',
        channel: 'D123',
        channel_type: 'im',
        user: 'U123',
        text: '!fast implement this plan',
        ts: '100.001',
        files,
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
    });

    expect(slack.downloadSlackFile).toHaveBeenCalledWith(files[0]);
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.stringContaining('Implement attachment forwarding.'),
        attachmentTexts: [
          expect.stringContaining('Implement attachment forwarding.'),
        ],
      }),
    );
    expect(
      JSON.stringify(mocks.answerQuestion.mock.calls[0]?.[0]),
    ).not.toContain('url_private_download');
  });

  it('can answer with a reaction without posting a text fallback', async () => {
    mocks.answerQuestion.mockImplementationOnce(
      async ({
        adapter,
      }: {
        adapter: { postReaction: (reaction: unknown) => void };
      }) => {
        await adapter.postReaction({
          name: 'thumbsup',
          purpose: 'closeout',
          messageId: '100.001',
        });
        return '';
      },
    );
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => []),
    };

    await processFastAgentMessage({
      event: {
        type: 'message',
        channel: 'D123',
        channel_type: 'im',
        user: 'U123',
        text: '!fast sounds good',
        ts: '100.001',
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
    });

    expect(slack.addReaction).toHaveBeenNthCalledWith(1, {
      channel: 'D123',
      timestamp: '100.001',
      name: 'eyes',
    });
    expect(slack.addReaction).toHaveBeenNthCalledWith(2, {
      channel: 'D123',
      timestamp: '100.001',
      name: 'thumbsup',
    });
    expect(slack.removeReaction).toHaveBeenCalledWith({
      channel: 'D123',
      timestamp: '100.001',
      name: 'eyes',
    });
    expect(mocks.postThreadMessage).not.toHaveBeenCalled();
  });

  it('keeps the processing reaction when it becomes the visible closeout', async () => {
    mocks.answerQuestion.mockImplementationOnce(
      async ({
        adapter,
      }: {
        adapter: { postReaction: (reaction: unknown) => void };
      }) => {
        await adapter.postReaction({
          name: 'eyes',
          purpose: 'closeout',
          messageId: '100.001',
        });
        return '';
      },
    );
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => []),
    };

    await processFastAgentMessage({
      event: {
        type: 'message',
        channel: 'D123',
        channel_type: 'im',
        user: 'U123',
        text: '!fast take a look',
        ts: '100.001',
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
    });

    expect(slack.addReaction).toHaveBeenCalledOnce();
    expect(slack.addReaction).toHaveBeenCalledWith({
      channel: 'D123',
      timestamp: '100.001',
      name: 'eyes',
    });
    expect(slack.removeReaction).not.toHaveBeenCalled();
    expect(mocks.postThreadMessage).not.toHaveBeenCalled();
  });

  it('clears a same-name processing reaction after an intermediate acknowledgement', async () => {
    mocks.answerQuestion.mockImplementationOnce(
      async ({
        adapter,
      }: {
        adapter: {
          postReaction: (reaction: unknown) => void;
          postReply: (reply: unknown) => void;
        };
      }) => {
        await adapter.postReaction({
          name: 'eyes',
          purpose: 'ack',
          messageId: '100.001',
        });
        await adapter.postReply({
          purpose: 'closeout',
          message: 'I found the answer.',
        });
        return 'I found the answer.';
      },
    );
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => []),
    };

    await processFastAgentMessage({
      event: {
        type: 'message',
        channel: 'D123',
        channel_type: 'im',
        user: 'U123',
        text: '!fast investigate this',
        ts: '100.001',
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
    });

    expect(slack.addReaction).toHaveBeenCalledOnce();
    expect(slack.removeReaction).toHaveBeenCalledWith({
      channel: 'D123',
      timestamp: '100.001',
      name: 'eyes',
    });
    expect(mocks.postThreadMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'I found the answer.' }),
    );
  });

  it('posts the returned fallback when no chat tool delivered a response', async () => {
    mocks.answerQuestion.mockResolvedValueOnce('Please try again.');
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => []),
    };

    await processFastAgentMessage({
      event: {
        type: 'message',
        channel: 'D123',
        channel_type: 'im',
        user: 'U123',
        text: '!fast hello',
        ts: '100.001',
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
    });

    expect(mocks.postThreadMessage).toHaveBeenCalledOnce();
    expect(mocks.postThreadMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Please try again.' }),
    );
  });

  it('completes quietly when the reply is suppressed for a deleted source message', async () => {
    mocks.postThreadMessage.mockResolvedValue('suppressed');
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => []),
    };

    await expect(
      processFastAgentMessage({
        event: {
          type: 'message',
          channel: 'D123',
          channel_type: 'im',
          user: 'U123',
          text: '!fast implement this',
          ts: '100.001',
        } as never,
        slack: slack as never,
        userId: 'user-1',
        teamId: 'T123',
      }),
    ).resolves.toBeUndefined();
    // The suppressed reply counts as handled: no fallback repost attempt.
    expect(mocks.postThreadMessage).toHaveBeenCalledOnce();
  });

  it('aborts a Fast launch when the kickoff post is suppressed', async () => {
    mocks.postThreadMessage.mockResolvedValue('suppressed');
    mocks.answerQuestion.mockImplementationOnce(
      async ({
        adapter,
      }: {
        adapter: { postReply: (reply: unknown) => void };
      }) => {
        await adapter.postReply({
          purpose: 'closeout',
          message: 'Delegated the work.',
          kickoff: true,
        });
        return 'Delegated the work.';
      },
    );
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => []),
    };

    await expect(
      processFastAgentMessage({
        event: {
          type: 'message',
          channel: 'D123',
          channel_type: 'im',
          user: 'U123',
          text: '!fast implement this',
          ts: '100.001',
        } as never,
        slack: slack as never,
        userId: 'user-1',
        teamId: 'T123',
      }),
    ).rejects.toThrow('The Fast kickoff was suppressed');
  });

  it('rejects a non-delivered parent reply instead of treating it as a kickoff', async () => {
    mocks.postThreadMessage.mockResolvedValue('failed');
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => []),
    };

    await expect(
      processFastAgentMessage({
        event: {
          type: 'message',
          channel: 'D123',
          channel_type: 'im',
          user: 'U123',
          text: '!fast implement this',
          ts: '100.001',
        } as never,
        slack: slack as never,
        userId: 'user-1',
        teamId: 'T123',
      }),
    ).rejects.toThrow('Slack did not accept the Fast parent reply.');
  });

  it('shows the task-processing reaction until the fast response is loaded', async () => {
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => [
        {
          user: 'U123',
          username: 'Matt',
          text: '!fast hi how are you',
          ts: '100.001',
          type: 'message',
        },
      ]),
    };

    await processFastAgentMessage({
      event: {
        type: 'message',
        channel: 'D123',
        channel_type: 'im',
        user: 'U123',
        text: '!fast hi how are you',
        ts: '100.001',
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
    });

    expect(slack.addReaction).toHaveBeenCalledWith({
      channel: 'D123',
      timestamp: '100.001',
      name: 'eyes',
    });
    expect(slack.removeReaction).toHaveBeenCalledWith({
      channel: 'D123',
      timestamp: '100.001',
      name: 'eyes',
    });
    expect(slack.addReaction.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.answerQuestion.mock.invocationCallOrder[0]!,
    );
    expect(mocks.answerQuestion.mock.invocationCallOrder[0]).toBeLessThan(
      slack.removeReaction.mock.invocationCallOrder[0]!,
    );
    expect(mocks.answerQuestion).toHaveBeenCalledOnce();
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: {
          surface: 'slack',
          workspaceId: 'T123',
          conversationId: '100.001',
          replyTarget: { channelId: 'D123', threadId: '100.001' },
        },
        senderDisplayName: 'Matt',
        senderExternalId: 'U123',
        threadContext: [],
      }),
    );
    expect(mocks.acquireLock).toHaveBeenCalledWith({
      conversation: {
        surface: 'slack',
        workspaceId: 'T123',
        conversationId: '100.001',
        replyTarget: { channelId: 'D123', threadId: '100.001' },
      },
    });
    expect(mocks.acquireLock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.hasSession.mock.invocationCallOrder[0]!,
    );
    expect(mocks.postThreadMessage).toHaveBeenCalledOnce();
    expect(mocks.releaseLock).toHaveBeenCalledOnce();
  });

  it('does not trust a current-message display name from another Slack user', async () => {
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => [
        {
          user: 'U_OTHER',
          username: 'Wrong Person',
          text: '!fast show my PRs',
          ts: '100.001',
          type: 'message',
        },
      ]),
    };

    await processFastAgentMessage({
      event: {
        type: 'message',
        channel: 'D123',
        channel_type: 'im',
        user: 'U123',
        text: '!fast show my PRs',
        ts: '100.001',
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
    });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        senderDisplayName: undefined,
        senderExternalId: 'U123',
      }),
    );
  });

  it('clears the task-processing reaction when fast processing fails', async () => {
    mocks.answerQuestion.mockRejectedValueOnce(new Error('model unavailable'));
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => []),
    };

    await expect(
      processFastAgentMessage({
        event: {
          type: 'message',
          channel: 'D123',
          channel_type: 'im',
          user: 'U123',
          text: '!fast hello',
          ts: '100.001',
        } as never,
        slack: slack as never,
        userId: 'user-1',
        teamId: 'T123',
      }),
    ).rejects.toThrow('model unavailable');

    expect(slack.removeReaction).toHaveBeenCalledWith({
      channel: 'D123',
      timestamp: '100.001',
      name: 'eyes',
    });
    expect(mocks.releaseLock).toHaveBeenCalledOnce();
  });

  it('does not add the processing reaction to an existing fast conversation', async () => {
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => []),
    };

    await processFastAgentMessage({
      event: {
        type: 'message',
        channel: 'D123',
        channel_type: 'im',
        thread_ts: '100.001',
        user: 'U123',
        text: 'Good, tired',
        ts: '100.002',
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
      continuation: true,
      isExistingConversation: true,
    });

    expect(slack.addReaction).not.toHaveBeenCalled();
    expect(slack.removeReaction).not.toHaveBeenCalled();
    expect(mocks.hasSession).not.toHaveBeenCalled();
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'Good, tired' }),
    );
  });

  it('allows silence for an unmentioned turn with another human participant', async () => {
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => [
        { user: 'U111', username: 'Dan', text: '!fast hi', ts: '100.000' },
        {
          user: 'UBOT',
          username: 'Roomote',
          bot_id: 'B999',
          text: 'Hi Dan.',
          ts: '100.001',
        },
        { user: 'U222', username: 'Matt', text: 'Makes sense', ts: '100.002' },
      ]),
    };

    await processFastAgentMessage({
      event: {
        type: 'message',
        channel: 'C123',
        user: 'U222',
        text: 'Makes sense',
        ts: '100.002',
        thread_ts: '100.000',
      } as never,
      slack: slack as never,
      userId: 'user-2',
      teamId: 'T123',
      continuation: true,
      isExistingConversation: true,
    });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ allowSilentAmbientReply: true }),
    );
  });

  it.each(['im', 'mpim'] as const)(
    'requires a response in a Slack %s conversation',
    async (channelType) => {
      const slack = {
        addReaction: vi.fn().mockResolvedValue(true),
        removeReaction: vi.fn().mockResolvedValue(true),
        normalizeIncomingText: vi.fn(async (text: string) => text),
        fetchThreadMessages: vi.fn(async () => [
          { user: 'U111', username: 'Dan', text: 'Earlier', ts: '100.000' },
          { user: 'U222', username: 'Matt', text: 'Help', ts: '100.002' },
        ]),
      };

      await processFastAgentMessage({
        event: {
          type: 'message',
          channel: 'D123',
          channel_type: channelType,
          user: 'U222',
          text: 'Help',
          ts: '100.002',
          thread_ts: '100.000',
        } as never,
        slack: slack as never,
        userId: 'user-2',
        teamId: 'T123',
        continuation: true,
        isExistingConversation: true,
      });

      expect(mocks.answerQuestion).toHaveBeenCalledWith(
        expect.objectContaining({ allowSilentAmbientReply: false }),
      );
    },
  );

  it('requires a response for a directed turn with another human participant', async () => {
    const slack = {
      addReaction: vi.fn().mockResolvedValue(true),
      removeReaction: vi.fn().mockResolvedValue(true),
      normalizeIncomingText: vi.fn(async (text: string) => text),
      fetchThreadMessages: vi.fn(async () => [
        { user: 'U111', username: 'Dan', text: 'Earlier', ts: '100.000' },
        { user: 'U222', username: 'Matt', text: '!fast help', ts: '100.002' },
      ]),
    };

    await processFastAgentMessage({
      event: {
        type: 'message',
        channel: 'C123',
        user: 'U222',
        text: '!fast help',
        ts: '100.002',
        thread_ts: '100.000',
      } as never,
      slack: slack as never,
      userId: 'user-2',
      teamId: 'T123',
      continuation: true,
      isExistingConversation: true,
      directedAtRoomote: true,
    });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ allowSilentAmbientReply: false }),
    );
  });
});
