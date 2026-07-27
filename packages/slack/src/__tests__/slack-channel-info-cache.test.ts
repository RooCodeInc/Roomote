import { SlackChannelInfoCache } from '../slack-channel-info-cache';
import { SlackNotifier } from '../slack-notifier';

const { redisStore, getRedisMock } = vi.hoisted(() => {
  const store = new Map<string, { value: string; ttlSeconds: number }>();

  return {
    redisStore: store,
    getRedisMock: vi.fn(() => ({
      get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
      set: vi.fn(
        async (key: string, value: string, _mode: string, ttl: number) => {
          store.set(key, { value, ttlSeconds: ttl });
          return 'OK';
        },
      ),
    })),
  };
});

vi.mock('@roomote/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/redis')>();

  return { ...actual, getRedis: getRedisMock };
});

vi.mock('@slack/web-api', () => ({ WebClient: vi.fn() }));

type GlobalWithFetchMock = { fetch: ReturnType<typeof vi.fn> };

const getGlobalWithFetch = (): GlobalWithFetchMock =>
  globalThis as unknown as GlobalWithFetchMock;

function mockConversationsInfo(
  channel: Record<string, unknown>,
): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, channel }),
  });
}

describe('SlackChannelInfoCache', () => {
  const token = 'xoxb-test-token';
  const originalBaseUrl = process.env.SLACK_API_BASE_URL;

  beforeEach(() => {
    process.env.SLACK_API_BASE_URL = 'https://slack.com/api/';
    redisStore.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.SLACK_API_BASE_URL;
      return;
    }

    process.env.SLACK_API_BASE_URL = originalBaseUrl;
  });

  it('resolves a channel once per request across every lookup', async () => {
    getGlobalWithFetch().fetch = mockConversationsInfo({
      name: 'roomote-managers',
      is_member: true,
      is_private: false,
    });

    const notifier = new SlackNotifier(token, {
      channelInfoCache: new SlackChannelInfoCache('T123'),
    });

    const [name, isMember, isPublic] = await Promise.all([
      notifier.getChannelName('C123'),
      notifier.isAppInChannel('C123'),
      notifier.isPublicChannel('C123'),
    ]);

    expect(name).toBe('roomote-managers');
    expect(isMember).toBe(true);
    expect(isPublic).toBe(true);
    expect(getGlobalWithFetch().fetch).toHaveBeenCalledTimes(1);
  });

  it('serves a later request from the shared cache without calling Slack', async () => {
    getGlobalWithFetch().fetch = mockConversationsInfo({
      name: 'roomote-managers',
      is_member: true,
      is_private: false,
    });

    const first = new SlackNotifier(token, {
      channelInfoCache: new SlackChannelInfoCache('T123'),
    });
    await first.getChannelName('C123');
    expect(getGlobalWithFetch().fetch).toHaveBeenCalledTimes(1);

    // A new cache instance stands in for the next request.
    const second = new SlackNotifier(token, {
      channelInfoCache: new SlackChannelInfoCache('T123'),
    });

    expect(await second.getChannelName('C123')).toBe('roomote-managers');
    expect(await second.isAppInChannel('C123')).toBe(true);
    expect(getGlobalWithFetch().fetch).toHaveBeenCalledTimes(1);
    expect([...redisStore.values()][0]?.ttlSeconds).toBe(600);
  });

  it('keeps caches for different workspaces apart', async () => {
    getGlobalWithFetch().fetch = mockConversationsInfo({
      name: 'roomote-managers',
      is_member: true,
    });

    await new SlackNotifier(token, {
      channelInfoCache: new SlackChannelInfoCache('T123'),
    }).getChannelName('C123');

    await new SlackNotifier(token, {
      channelInfoCache: new SlackChannelInfoCache('T999'),
    }).getChannelName('C123');

    expect(getGlobalWithFetch().fetch).toHaveBeenCalledTimes(2);
  });

  it('caches an inaccessible channel with the shorter negative TTL', async () => {
    getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error: 'channel_not_found' }),
    });

    const notifier = new SlackNotifier(token, {
      channelInfoCache: new SlackChannelInfoCache('T123'),
    });

    expect(await notifier.isAppInChannel('C404')).toBe(false);
    expect(await notifier.getChannelName('C404')).toBeNull();
    expect([...redisStore.values()][0]?.ttlSeconds).toBe(60);

    const next = new SlackNotifier(token, {
      channelInfoCache: new SlackChannelInfoCache('T123'),
    });

    expect(await next.isAppInChannel('C404')).toBe(false);
    expect(getGlobalWithFetch().fetch).toHaveBeenCalledTimes(1);
  });

  it('caches a channel the bot has not joined with the shorter TTL', async () => {
    // Inviting the bot must take effect in seconds: an operator fixing this
    // should not wait out the full positive TTL to clear the warning.
    getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        channel: { id: 'C777', name: 'hospital-alerts', is_member: false },
      }),
    });

    const notifier = new SlackNotifier(token, {
      channelInfoCache: new SlackChannelInfoCache('T123'),
    });

    expect(await notifier.isAppInChannel('C777')).toBe(false);
    expect([...redisStore.values()][0]?.ttlSeconds).toBe(60);
  });

  it('does not cache lookups Slack never resolved', async () => {
    getGlobalWithFetch().fetch = vi
      .fn()
      .mockRejectedValue(new Error('network error'));
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      expect(
        await new SlackNotifier(token, {
          channelInfoCache: new SlackChannelInfoCache('T123'),
        }).isAppInChannel('C123'),
      ).toBeNull();

      expect(redisStore.size).toBe(0);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('skips the shared cache when no workspace scope is given', async () => {
    getGlobalWithFetch().fetch = mockConversationsInfo({ name: 'general' });

    const notifier = new SlackNotifier(token, {
      channelInfoCache: new SlackChannelInfoCache(null),
    });

    await notifier.getChannelName('C123');

    expect(redisStore.size).toBe(0);
    expect(getRedisMock).not.toHaveBeenCalled();
  });

  it('still calls Slack per lookup when no cache is supplied', async () => {
    getGlobalWithFetch().fetch = mockConversationsInfo({
      name: 'general',
      is_member: true,
    });

    const notifier = new SlackNotifier(token);

    await notifier.getChannelName('C123');
    await notifier.isAppInChannel('C123');

    expect(getGlobalWithFetch().fetch).toHaveBeenCalledTimes(2);
  });
});
