const upsertMessageMock = vi.hoisted(() => vi.fn());

vi.mock('../fast-agent-conversation-repository', () => ({
  fastAgentConversationRepository: {
    upsertMessage: upsertMessageMock,
  },
}));

import { upsertFastAgentMessage } from '../fast-agent-session';

const message = {
  eventId: 'turn-1:user',
  turnId: 'turn-1',
  turnSeq: 0,
  ts: 1,
  eventType: 'roomote_runtime.user_prompt' as const,
  role: 'user' as const,
  contentBlocks: [{ type: 'text' as const, text: 'Hello' }],
  metadata: { visibleInTranscript: true },
  payload: {},
  source: 'slack',
};

describe('upsertFastAgentMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retries one transient canonical database failure', async () => {
    upsertMessageMock
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined);

    await expect(
      upsertFastAgentMessage({ sessionId: 'session-1', message }),
    ).resolves.toBeUndefined();
    expect(upsertMessageMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a repeated canonical database failure', async () => {
    upsertMessageMock.mockRejectedValue(new Error('database unavailable'));

    await expect(
      upsertFastAgentMessage({ sessionId: 'session-1', message }),
    ).rejects.toThrow('database unavailable');
    expect(upsertMessageMock).toHaveBeenCalledTimes(2);
  });
});
