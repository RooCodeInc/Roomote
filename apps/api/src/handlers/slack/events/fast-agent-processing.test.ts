const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  answerQuestion: vi.fn(),
  postThreadMessage: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  acquireRedisLock: mocks.acquireLock,
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  answerFastAgentQuestion: mocks.answerQuestion,
}));

vi.mock('@roomote/cloud-agents', () => ({
  stripLeadingSlackProductMention: (text: string) => text,
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
    mocks.postThreadMessage.mockResolvedValue(true);
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

  it('rejects a non-delivered parent reply instead of treating it as a kickoff', async () => {
    mocks.postThreadMessage.mockResolvedValue(false);
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
    expect(mocks.acquireLock).toHaveBeenCalledWith(
      expect.stringContaining('T123:D123:100.001'),
      expect.anything(),
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
});
