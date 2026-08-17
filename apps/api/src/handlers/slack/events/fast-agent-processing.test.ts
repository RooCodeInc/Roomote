const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  answerQuestion: vi.fn(),
  processAttachments: vi.fn(),
  postThreadMessage: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireLock,
  answerFastAgentQuestion: mocks.answerQuestion,
  FAST_AGENT_MAX_IMAGE_ATTACHMENTS: 3,
}));

vi.mock('@roomote/cloud-agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/cloud-agents')>()),
  stripLeadingSlackProductMention: (text: string) => text,
}));

vi.mock('../helpers/attachments.js', () => ({
  processSlackAttachments: mocks.processAttachments,
}));

vi.mock('../helpers/thread-posting.js', () => ({
  postSlackThreadMarkdownMessage: mocks.postThreadMessage,
}));

import { processFastAgentMessage } from './fast-agent.js';

describe('processFastAgentMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireLock.mockResolvedValue(mocks.releaseLock);
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.postThreadMessage.mockResolvedValue('posted');
    mocks.processAttachments.mockResolvedValue({
      images: [],
      attachmentTexts: [],
      videoDescriptions: [],
    });
    mocks.answerQuestion.mockImplementation(
      async ({
        postSlackReply,
      }: {
        postSlackReply: (reply: unknown) => void;
      }) => {
        await postSlackReply({
          purpose: 'closeout',
          message: 'Doing well.',
        });
        return 'Doing well.';
      },
    );
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
      activeTasks: [
        { taskId: 'task-1', title: 'Fix API' },
        { taskId: 'task-2', title: 'Update docs' },
      ],
    });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'investigate this',
        currentMessageAgentContext: 'Slack block text:\nState: New',
        activeTasks: [
          { taskId: 'task-1', title: 'Fix API' },
          { taskId: 'task-2', title: 'Update docs' },
        ],
      }),
    );
  });

  it('can answer with a reaction without posting a text fallback', async () => {
    mocks.answerQuestion.mockImplementationOnce(
      async ({
        postSlackReaction,
      }: {
        postSlackReaction: (reaction: unknown) => void;
      }) => {
        await postSlackReaction({
          name: 'thumbsup',
          purpose: 'closeout',
          slackMessageTs: '100.001',
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
        postSlackReaction,
      }: {
        postSlackReaction: (reaction: unknown) => void;
      }) => {
        await postSlackReaction({
          name: 'eyes',
          purpose: 'closeout',
          slackMessageTs: '100.001',
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
        postSlackReaction,
        postSlackReply,
      }: {
        postSlackReaction: (reaction: unknown) => void;
        postSlackReply: (reply: unknown) => void;
      }) => {
        await postSlackReaction({
          name: 'eyes',
          purpose: 'ack',
          slackMessageTs: '100.001',
        });
        await postSlackReply({
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
        postSlackReply,
      }: {
        postSlackReply: (reply: unknown) => void;
      }) => {
        await postSlackReply({
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
        slackTeamId: 'T123',
        senderDisplayName: 'Matt',
        senderSlackUserId: 'U123',
        threadContext: [],
      }),
    );
    expect(mocks.acquireLock).toHaveBeenCalledWith({
      slackTeamId: 'T123',
      slackChannel: 'D123',
      slackThreadTs: '100.001',
    });
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
        senderSlackUserId: 'U123',
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

  it('accepts ordinary text when continuing an existing fast thread', async () => {
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
    });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'Good, tired' }),
    );
  });

  it('passes Slack screenshots to Fast mode with the user question', async () => {
    mocks.processAttachments.mockResolvedValueOnce({
      images: [
        'data:image/png;base64,aW1hZ2UtMQ==',
        'data:image/png;base64,aW1hZ2UtMg==',
        'data:image/png;base64,aW1hZ2UtMw==',
      ],
      attachmentTexts: [],
      videoDescriptions: [],
    });
    const files = Array.from({ length: 4 }, (_, index) => ({
      id: `F12${index}`,
      name: `screenshot-${index}.png`,
      mimetype: 'image/png',
      size: 1024,
    }));
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
        text: '!fast what is wrong here?',
        ts: '100.001',
        files,
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
    });

    expect(mocks.processAttachments).toHaveBeenCalledWith({
      slack,
      files: files.slice(0, 3),
      userId: 'user-1',
      userTextContext: '!fast what is wrong here?',
    });
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'what is wrong here?',
        images: [
          'data:image/png;base64,aW1hZ2UtMQ==',
          'data:image/png;base64,aW1hZ2UtMg==',
          'data:image/png;base64,aW1hZ2UtMw==',
        ],
      }),
    );
  });

  it('treats an image-only Fast follow-up as a multimodal question', async () => {
    mocks.processAttachments.mockResolvedValueOnce({
      images: ['data:image/png;base64,Zm9sbG93dXA='],
      attachmentTexts: [],
      videoDescriptions: [],
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
        channel: 'D123',
        channel_type: 'im',
        thread_ts: '100.001',
        user: 'U123',
        text: '',
        ts: '100.002',
        files: [
          {
            id: 'F124',
            name: 'screenshot.png',
            mimetype: 'image/png',
            size: 1024,
          },
        ],
      } as never,
      slack: slack as never,
      userId: 'user-1',
      teamId: 'T123',
      continuation: true,
    });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.stringContaining('shared an image'),
        images: ['data:image/png;base64,Zm9sbG93dXA='],
      }),
    );
    expect(mocks.postThreadMessage).toHaveBeenCalledOnce();
    expect(mocks.postThreadMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('/fast') }),
    );
  });
});
