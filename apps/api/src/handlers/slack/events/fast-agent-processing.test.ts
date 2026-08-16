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
        await postSlackReply({ type: 'final_answer', text: 'Doing well.' });
        return 'Doing well.';
      },
    );
  });

  it('answers without adding task-processing reactions', async () => {
    const slack = {
      addReaction: vi.fn(),
      removeReaction: vi.fn(),
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

    expect(slack.addReaction).not.toHaveBeenCalled();
    expect(slack.removeReaction).not.toHaveBeenCalled();
    expect(mocks.answerQuestion).toHaveBeenCalledOnce();
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        slackTeamId: 'T123',
        senderDisplayName: 'Matt',
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

  it('accepts ordinary text when continuing an existing fast thread', async () => {
    const slack = {
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
