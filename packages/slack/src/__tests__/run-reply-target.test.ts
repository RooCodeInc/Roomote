const { delMock, getMock, setMock } = vi.hoisted(() => ({
  delMock: vi.fn(),
  getMock: vi.fn(),
  setMock: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({ del: delMock, get: getMock, set: setMock }),
}));

import {
  activateSlackRunReplyTarget,
  authorizeSlackRunReplyTarget,
  clearActiveSlackRunReplyTarget,
  getActiveSlackRunReplyTarget,
} from '../run-reply-target';

describe('Slack run reply targets', () => {
  const target = {
    slackTeamId: 'T123',
    channel: 'C123',
    threadTs: '111.222',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockResolvedValue(null);
    delMock.mockResolvedValue(1);
    setMock.mockResolvedValue('OK');
  });

  it('authorizes and activates a message-scoped target for the run', async () => {
    await authorizeSlackRunReplyTarget({
      runId: 42,
      messageTs: '333.444',
      target,
    });
    expect(setMock).toHaveBeenCalledWith(
      'slack:run_reply_target:pending:42:333.444',
      JSON.stringify(target),
      'EX',
      7 * 24 * 60 * 60,
    );

    getMock.mockResolvedValueOnce(JSON.stringify(target));
    await expect(
      activateSlackRunReplyTarget({ runId: 42, messageTs: '333.444' }),
    ).resolves.toEqual(target);
    expect(setMock).toHaveBeenLastCalledWith(
      'slack:run_reply_target:active:42',
      JSON.stringify(target),
      'EX',
      7 * 24 * 60 * 60,
    );
  });

  it('does not activate a missing or malformed authorized target', async () => {
    getMock.mockResolvedValueOnce(null).mockResolvedValueOnce('not-json');

    await expect(
      activateSlackRunReplyTarget({ runId: 42, messageTs: 'missing' }),
    ).resolves.toBe(false);
    expect(delMock).toHaveBeenCalledWith('slack:run_reply_target:active:42');
    await expect(
      activateSlackRunReplyTarget({ runId: 42, messageTs: 'malformed' }),
    ).resolves.toBe(false);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('reads only a valid active target', async () => {
    getMock
      .mockResolvedValueOnce(JSON.stringify(target))
      .mockResolvedValueOnce(JSON.stringify({ channel: 'C123' }));

    await expect(getActiveSlackRunReplyTarget(42)).resolves.toEqual(target);
    await expect(getActiveSlackRunReplyTarget(42)).resolves.toBeNull();
  });

  it('clears the active target at run lifecycle boundaries', async () => {
    await clearActiveSlackRunReplyTarget(42);

    expect(delMock).toHaveBeenCalledWith('slack:run_reply_target:active:42');
  });
});
