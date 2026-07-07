import { SlackChannelDiscovery } from '../slack-channel-discovery';

describe('SlackChannelDiscovery', () => {
  const token = 'xoxb-test-token';
  let fetchMock: ReturnType<typeof vi.fn>;
  let discovery: SlackChannelDiscovery;

  beforeEach(() => {
    fetchMock = vi.fn();
    discovery = new SlackChannelDiscovery(
      token,
      fetchMock as unknown as typeof fetch,
    );
    vi.clearAllMocks();
  });

  describe('listPublicChannels', () => {
    it('paginates, retries rate limits, and returns sorted public channels', async () => {
      vi.useFakeTimers();
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      try {
        fetchMock
          .mockResolvedValueOnce({
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            headers: {
              get: (name: string) => (name === 'Retry-After' ? '2' : null),
            },
          })
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              ok: true,
              channels: [
                { id: 'C300', name: 'zebra' },
                { id: 'C100', name: 'alpha' },
              ],
              response_metadata: { next_cursor: 'cursor-2' },
            }),
          })
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              ok: true,
              channels: [{ id: 'C200', name: 'middle' }],
              response_metadata: { next_cursor: '' },
            }),
          });

        const resultPromise = discovery.listPublicChannels();

        await Promise.resolve();

        expect(fetchMock).toHaveBeenNthCalledWith(
          1,
          'https://slack.com/api/conversations.list?exclude_archived=true&limit=999&types=public_channel',
          expect.objectContaining({
            method: 'GET',
            headers: expect.objectContaining({
              Authorization: `Bearer ${token}`,
            }),
          }),
        );

        await vi.advanceTimersByTimeAsync(2000);

        await expect(resultPromise).resolves.toEqual([
          { id: 'C100', name: 'alpha', isPrivate: false, isMember: null },
          { id: 'C200', name: 'middle', isPrivate: false, isMember: null },
          { id: 'C300', name: 'zebra', isPrivate: false, isMember: null },
        ]);
        expect(fetchMock).toHaveBeenNthCalledWith(
          3,
          'https://slack.com/api/conversations.list?exclude_archived=true&limit=999&types=public_channel&cursor=cursor-2',
          expect.any(Object),
        );
        expect(consoleErrorSpy).not.toHaveBeenCalled();
      } finally {
        consoleErrorSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('logs and returns collected channels when a later page fails', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      try {
        fetchMock
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              ok: true,
              channels: [{ id: 'C100', name: 'alpha' }],
              response_metadata: { next_cursor: 'cursor-2' },
            }),
          })
          .mockResolvedValueOnce({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            headers: {
              get: () => null,
            },
          });

        await expect(discovery.listPublicChannels()).resolves.toEqual([
          { id: 'C100', name: 'alpha', isPrivate: false, isMember: null },
        ]);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[listPublicChannels] Slack conversations.list failed: 500 Internal Server Error',
        );
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });
  });

  describe('listAccessibleChannels', () => {
    it('returns public and private channels visible to the bot', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          channels: [
            {
              id: 'G200',
              name: 'eng-private',
              is_private: true,
              is_member: true,
            },
            {
              id: 'C100',
              name: 'general',
              is_private: false,
              is_member: false,
            },
          ],
          response_metadata: { next_cursor: '' },
        }),
      });

      await expect(discovery.listAccessibleChannels()).resolves.toEqual([
        { id: 'G200', name: 'eng-private', isPrivate: true, isMember: true },
        { id: 'C100', name: 'general', isPrivate: false, isMember: false },
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://slack.com/api/conversations.list?exclude_archived=true&limit=999&types=public_channel%2Cprivate_channel',
        expect.any(Object),
      );
    });

    it('fails fast when conversations.list is rate limited', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      try {
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: {
            get: (name: string) => (name === 'Retry-After' ? '60' : null),
          },
        });

        await expect(discovery.listAccessibleChannels()).resolves.toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[listAccessibleChannels] Slack conversations.list exhausted 0 rate-limit retries',
        );
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });
  });

  describe('resolveChannelId', () => {
    it('paginates and resolves channel names by id', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      try {
        fetchMock
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              ok: true,
              channels: [{ id: 'C100', name: 'general' }],
              response_metadata: { next_cursor: 'cursor-2' },
            }),
          })
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              ok: true,
              channels: [{ id: 'C999', name: 'team-updates' }],
              response_metadata: { next_cursor: '' },
            }),
          });

        await expect(discovery.resolveChannelId('#Team-Updates')).resolves.toBe(
          'C999',
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock).toHaveBeenNthCalledWith(
          1,
          'https://slack.com/api/conversations.list?exclude_archived=true&limit=999&types=public_channel%2Cprivate_channel',
          expect.objectContaining({
            method: 'GET',
            headers: expect.objectContaining({
              Authorization: `Bearer ${token}`,
            }),
          }),
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
          2,
          'https://slack.com/api/conversations.list?exclude_archived=true&limit=999&types=public_channel%2Cprivate_channel&cursor=cursor-2',
          expect.any(Object),
        );
        expect(consoleErrorSpy).not.toHaveBeenCalled();
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it('fails fast when conversations.list is rate limited', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      try {
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: {
            get: (name: string) => (name === 'Retry-After' ? '60' : null),
          },
        });

        await expect(
          discovery.resolveChannelId('#team-updates'),
        ).resolves.toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[resolveChannelId] Slack conversations.list exhausted 0 rate-limit retries',
        );
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it('returns null and logs when conversations.list fails', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      try {
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: false,
            error: 'missing_scope',
          }),
        });

        await expect(
          discovery.resolveChannelId('#team-updates'),
        ).resolves.toBeNull();
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[resolveChannelId] Slack conversations.list error: missing_scope',
        );
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });
  });
});
