const {
  consumeMcpOauthReplayMock,
  sessionsFindFirstMock,
  replyToFastSessionMock,
  loggerErrorMock,
} = vi.hoisted(() => ({
  consumeMcpOauthReplayMock: vi.fn(),
  sessionsFindFirstMock: vi.fn(),
  replyToFastSessionMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: { query: { sessions: { findFirst: sessionsFindFirstMock } } },
  sessions: { id: 'sessions.id', ownerKind: 'k', ownerUserId: 'o' },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((column: string, value: string) => ({ column, value })),
}));
vi.mock('@roomote/sdk/server', () => ({
  consumeMcpOauthReplay: consumeMcpOauthReplayMock,
}));
vi.mock('@/trpc/commands/fast-sessions', () => ({
  replyToFastSessionCommand: replyToFastSessionMock,
}));
vi.mock('@/lib/server/logger', () => ({
  logger: { error: loggerErrorMock },
}));

import { resumeFastSessionFromReplay } from './mcp-oauth-replay-continuation';

const authResult = { success: true, userId: 'user-1' } as never;
const replay = {
  userId: 'user-1',
  connectionId: 'conn-1',
  mcpId: 'custom:server-1',
  sessionId: 'session-1',
};
const input = {
  replayToken: 'replay-1',
  authResult,
  connectionId: 'conn-1',
  mcpId: 'custom:server-1',
  text: 'continue',
  event: 'test_event',
};

describe('resumeFastSessionFromReplay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumeMcpOauthReplayMock.mockResolvedValue(replay);
    sessionsFindFirstMock.mockResolvedValue({
      archivedAt: null,
      fastConversationId: 'conv-1',
    });
    replyToFastSessionMock.mockResolvedValue(undefined);
  });

  it('posts the continuation into the owner Session', async () => {
    await expect(resumeFastSessionFromReplay(input)).resolves.toBe(true);
    expect(replyToFastSessionMock).toHaveBeenCalledWith(authResult, {
      sessionId: 'conv-1',
      text: 'continue',
    });
  });

  it.each([
    ['another user', { ...replay, userId: 'user-2' }],
    ['another connection', { ...replay, connectionId: 'conn-2' }],
    ['another integration', { ...replay, mcpId: 'custom:other' }],
    ['no Session', { ...replay, sessionId: null }],
    ['no replay', null],
  ])('ignores a replay for %s', async (_label, value) => {
    consumeMcpOauthReplayMock.mockResolvedValue(value);
    await expect(resumeFastSessionFromReplay(input)).resolves.toBe(false);
    expect(replyToFastSessionMock).not.toHaveBeenCalled();
  });

  it('ignores an archived or missing owner Session', async () => {
    sessionsFindFirstMock.mockResolvedValue({
      archivedAt: new Date(),
      fastConversationId: 'conv-1',
    });
    await expect(resumeFastSessionFromReplay(input)).resolves.toBe(false);
    sessionsFindFirstMock.mockResolvedValue(undefined);
    await expect(resumeFastSessionFromReplay(input)).resolves.toBe(false);
    expect(replyToFastSessionMock).not.toHaveBeenCalled();
  });

  it('logs and reports false when posting fails', async () => {
    replyToFastSessionMock.mockRejectedValue(new Error('boom'));
    await expect(resumeFastSessionFromReplay(input)).resolves.toBe(false);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'test_event', errorName: 'Error' }),
      expect.any(String),
    );
  });
});
