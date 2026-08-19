const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  answerQuestion: vi.fn(),
  postThreadMessage: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireLock,
  answerFastAgentQuestion: mocks.answerQuestion,
}));

vi.mock('@roomote/cloud-agents', () => ({
  stripLeadingSlackProductMention: (text: string) => text,
}));

vi.mock('../helpers/thread-posting.js', () => ({
  postSlackThreadMarkdownMessage: mocks.postThreadMessage,
}));

import { processFastAgentMessage as processFastAgentMessageImpl } from './fast-agent.js';

type ProcessFastAgentMessageParams = Parameters<
  typeof processFastAgentMessageImpl
>[0];
const launchTask = vi.fn();
const processFastAgentMessage = (
  params: Omit<ProcessFastAgentMessageParams, 'launchTask'>,
) => processFastAgentMessageImpl({ ...params, launchTask });

describe('processFastAgentMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireLock.mockResolvedValue(mocks.releaseLock);
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.postThreadMessage.mockResolvedValue('posted');
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
        adapter: expect.objectContaining({ launchTask }),
        activeTasks: [
          { taskId: 'task-1', title: 'Fix API' },
          { taskId: 'task-2', title: 'Update docs' },
        ],
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
});
