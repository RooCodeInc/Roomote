const { conversations, createClient } = vi.hoisted(() => ({
  conversations: {
    list: vi.fn(),
    create: vi.fn(),
    info: vi.fn(),
    join: vi.fn(),
  },
  createClient: vi.fn(),
}));

vi.mock('../web-client', () => ({ createSlackWebClient: createClient }));

import { ensureSlackManagerChannel } from '../ensure-slack-manager-channel';

const safeChannel = {
  id: 'CMANAGERS',
  name: 'roomote-managers',
  is_private: false,
  is_archived: false,
  is_shared: false,
  is_ext_shared: false,
  is_org_shared: false,
  is_pending_ext_shared: false,
  is_member: true,
};

describe('ensureSlackManagerChannel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    createClient.mockReturnValue({ conversations });
    conversations.list.mockResolvedValue({ ok: true, channels: [safeChannel] });
    conversations.create.mockResolvedValue({ ok: true, channel: safeChannel });
    conversations.info.mockResolvedValue({ ok: true, channel: safeChannel });
    conversations.join.mockResolvedValue({ ok: true, channel: safeChannel });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('creates the exact public channel using the installation bot token', async () => {
    conversations.list.mockResolvedValue({ ok: true, channels: [] });
    await expect(ensureSlackManagerChannel('bot-token')).resolves.toBe(
      'CMANAGERS',
    );
    expect(createClient).toHaveBeenCalledWith(
      'bot-token',
      expect.objectContaining({
        timeout: 5_000,
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
        suppressTimeoutLog: true,
        logger: expect.any(Object),
      }),
    );
    expect(conversations.create).toHaveBeenCalledExactlyOnceWith({
      name: 'roomote-managers',
      is_private: false,
    });
    expect(conversations.info).toHaveBeenCalledTimes(2);
    expect(conversations.join).not.toHaveBeenCalled();
  });

  it('reuses an existing member channel without mutation', async () => {
    await expect(ensureSlackManagerChannel('bot')).resolves.toBe('CMANAGERS');
    expect(conversations.create).not.toHaveBeenCalled();
    expect(conversations.join).not.toHaveBeenCalled();
    expect(conversations.list).toHaveBeenCalledWith({
      types: 'public_channel',
      exclude_archived: false,
      limit: 200,
      cursor: undefined,
    });
  });

  it('validates fresh info before joining and final info after joining', async () => {
    conversations.info.mockResolvedValueOnce({
      ok: true,
      channel: { ...safeChannel, is_member: false },
    });
    await expect(ensureSlackManagerChannel('bot')).resolves.toBe('CMANAGERS');
    expect(conversations.join).toHaveBeenCalledExactlyOnceWith({
      channel: 'CMANAGERS',
    });
    expect(conversations.info.mock.invocationCallOrder[0]).toBeLessThan(
      conversations.join.mock.invocationCallOrder[0]!,
    );
    expect(conversations.info.mock.invocationCallOrder[1]).toBeGreaterThan(
      conversations.join.mock.invocationCallOrder[0]!,
    );
  });

  it('rediscoveries only public channels after concurrent name_taken', async () => {
    conversations.list.mockResolvedValueOnce({ ok: true, channels: [] });
    conversations.create.mockRejectedValue(
      Object.assign(new Error('name_taken'), {
        data: { error: 'name_taken' },
      }),
    );
    await expect(ensureSlackManagerChannel('bot')).resolves.toBe('CMANAGERS');
    expect(conversations.list).toHaveBeenCalledTimes(2);
    expect(
      conversations.list.mock.calls.every(
        ([args]) => args.types === 'public_channel',
      ),
    ).toBe(true);
    expect(conversations.create).toHaveBeenCalledTimes(1);
  });

  it('does not look up a private name collision or try another name', async () => {
    conversations.list.mockResolvedValue({ ok: true, channels: [] });
    conversations.create.mockRejectedValue(
      Object.assign(new Error('name_taken'), {
        data: { error: 'name_taken' },
      }),
    );
    await expect(ensureSlackManagerChannel('bot')).resolves.toBeNull();
    expect(conversations.create).toHaveBeenCalledTimes(1);
    expect(conversations.info).not.toHaveBeenCalled();
    expect(conversations.join).not.toHaveBeenCalled();
  });

  it.each([
    { is_private: true },
    { is_archived: true },
    { is_shared: true },
    { is_ext_shared: true },
    { is_org_shared: true },
    { is_pending_ext_shared: true },
    { pending_shared: ['TOTHER'] },
    { pending_connected_team_ids: ['TOTHER'] },
    { is_private: undefined },
    { is_archived: undefined },
    { is_shared: undefined },
    { is_ext_shared: undefined },
    { is_org_shared: undefined },
    { is_pending_ext_shared: undefined },
  ])(
    'rejects unsafe or unknown discovery flags %j without touching the channel',
    async (flags) => {
      conversations.list.mockResolvedValue({
        ok: true,
        channels: [{ ...safeChannel, ...flags }],
      });
      await expect(ensureSlackManagerChannel('bot')).resolves.toBeNull();
      expect(conversations.create).not.toHaveBeenCalled();
      expect(conversations.info).not.toHaveBeenCalled();
      expect(conversations.join).not.toHaveBeenCalled();
    },
  );

  it.each([
    { is_private: true },
    { is_archived: true },
    { is_shared: true },
    { name: 'renamed' },
    { id: 'COTHER' },
  ])('rejects changes before joining %j', async (flags) => {
    conversations.info.mockResolvedValueOnce({
      ok: true,
      channel: { ...safeChannel, is_member: false, ...flags },
    });
    await expect(ensureSlackManagerChannel('bot')).resolves.toBeNull();
    expect(conversations.join).not.toHaveBeenCalled();
  });

  it.each([
    { is_private: true },
    { is_shared: true },
    { is_member: false },
    { name: 'renamed' },
  ])('rejects unsafe final state %j', async (flags) => {
    conversations.info.mockResolvedValueOnce({
      ok: true,
      channel: { ...safeChannel, is_member: false },
    });
    conversations.info.mockResolvedValueOnce({
      ok: true,
      channel: { ...safeChannel, ...flags },
    });
    await expect(ensureSlackManagerChannel('bot')).resolves.toBeNull();
    expect(conversations.join).toHaveBeenCalledTimes(1);
  });

  it.each(['missing_scope', 'network error', 'rate_limited', 'timeout'])(
    'returns null on %s without logging errors or tokens',
    async (message) => {
      conversations.list.mockRejectedValue(
        new Error(`${message} secret-token`),
      );
      await expect(
        ensureSlackManagerChannel('secret-token'),
      ).resolves.toBeNull();
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(
        '[Slack] Could not ensure public manager channel',
      );
      expect(conversations.list).toHaveBeenCalledTimes(1);
      expect(conversations.create).not.toHaveBeenCalled();
    },
  );

  it('paginates public discovery before deciding whether to create', async () => {
    conversations.list.mockResolvedValueOnce({
      ok: true,
      channels: [],
      response_metadata: { next_cursor: 'next' },
    });
    await expect(ensureSlackManagerChannel('bot')).resolves.toBe('CMANAGERS');
    expect(conversations.list.mock.calls[1]?.[0].cursor).toBe('next');
    expect(conversations.create).not.toHaveBeenCalled();
  });

  it('fails closed on truncated discovery even if a candidate was found', async () => {
    conversations.list.mockImplementation(async () => ({
      ok: true,
      channels: [safeChannel],
      response_metadata: {
        next_cursor: `page-${conversations.list.mock.calls.length}`,
      },
    }));
    await expect(ensureSlackManagerChannel('bot')).resolves.toBeNull();
    expect(conversations.list).toHaveBeenCalledTimes(10);
    expect(conversations.create).not.toHaveBeenCalled();
    expect(conversations.info).not.toHaveBeenCalled();
  });

  it('fails closed on a repeated cursor', async () => {
    conversations.list.mockResolvedValue({
      ok: true,
      channels: [],
      response_metadata: { next_cursor: 'same' },
    });
    await expect(ensureSlackManagerChannel('bot')).resolves.toBeNull();
    expect(conversations.list).toHaveBeenCalledTimes(2);
    expect(conversations.create).not.toHaveBeenCalled();
  });

  it('bounds a stalled request and never continues to create after it resolves late', async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    conversations.list.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const result = ensureSlackManagerChannel('bot');
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toBeNull();
    resolve({ ok: true, channels: [] });
    await vi.runAllTimersAsync();
    expect(conversations.create).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips empty tokens', async () => {
    await expect(ensureSlackManagerChannel('  ')).resolves.toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('rejects an unsafe create response without looking up or joining its ID', async () => {
    conversations.list.mockResolvedValue({ ok: true, channels: [] });
    conversations.create.mockResolvedValue({
      ok: true,
      channel: { ...safeChannel, is_private: true },
    });
    await expect(ensureSlackManagerChannel('bot')).resolves.toBeNull();
    expect(conversations.info).not.toHaveBeenCalled();
    expect(conversations.join).not.toHaveBeenCalled();
  });

  it('does not join when fresh membership is unknown', async () => {
    conversations.info.mockResolvedValue({
      ok: true,
      channel: { ...safeChannel, is_member: undefined },
    });
    await expect(ensureSlackManagerChannel('bot')).resolves.toBeNull();
    expect(conversations.join).not.toHaveBeenCalled();
  });

  it.each(['create', 'info', 'join'] as const)(
    'contains errors from %s without retries',
    async (method) => {
      if (method === 'create')
        conversations.list.mockResolvedValue({ ok: true, channels: [] });
      if (method === 'join')
        conversations.info.mockResolvedValueOnce({
          ok: true,
          channel: { ...safeChannel, is_member: false },
        });
      conversations[method].mockRejectedValue(
        new Error('missing_scope secret-token'),
      );
      await expect(
        ensureSlackManagerChannel('secret-token'),
      ).resolves.toBeNull();
      expect(conversations[method]).toHaveBeenCalledTimes(1);
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(
        '[Slack] Could not ensure public manager channel',
      );
    },
  );
});
