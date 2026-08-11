// pnpm --filter @roomote/slack test src/__tests__/slack-notifier.test.ts

import type { SlackFile, WorkObjectMetadata, WorkObjectUnfurl } from '../types';
import { SlackNotifier } from '../slack-notifier';
import { Env } from '@roomote/env';

const { apiCallMock, chatUnfurlMock, WebClientMock } = vi.hoisted(() => ({
  apiCallMock: vi.fn(),
  chatUnfurlMock: vi.fn(),
  WebClientMock: vi.fn().mockImplementation(function () {
    return {
      apiCall: apiCallMock,
      chat: {
        unfurl: chatUnfurlMock,
      },
    };
  }),
}));

type GlobalWithFetchMock = {
  fetch: ReturnType<typeof vi.fn>;
};

const getGlobalWithFetch = (): GlobalWithFetchMock =>
  globalThis as unknown as GlobalWithFetchMock;

vi.mock('@slack/web-api', () => {
  return {
    WebClient: WebClientMock,
  };
});

describe('SlackNotifier', () => {
  const token = 'xoxb-test-token';
  const originalBaseUrl = process.env.SLACK_API_BASE_URL;
  let notifier: SlackNotifier;

  beforeEach(() => {
    process.env.SLACK_API_BASE_URL = 'https://slack.com/api/';
    notifier = new SlackNotifier(token);
    vi.clearAllMocks();
    getGlobalWithFetch().fetch = vi.fn();
  });

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.SLACK_API_BASE_URL;
      return;
    }

    process.env.SLACK_API_BASE_URL = originalBaseUrl;
  });

  describe('getDirectMessageUserId', () => {
    it('returns the user for a one-to-one direct message', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          channel: { id: 'D123ABC456', is_im: true, user: 'U123ABC456' },
        }),
      });

      await expect(notifier.getDirectMessageUserId('D123ABC456')).resolves.toBe(
        'U123ABC456',
      );
      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        'https://slack.com/api/conversations.info?channel=D123ABC456',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('returns null when the target is not a one-to-one direct message', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          channel: { id: 'C123ABC456', is_im: false },
        }),
      });

      await expect(
        notifier.getDirectMessageUserId('C123ABC456'),
      ).resolves.toBeNull();
    });
  });

  describe('postMessage', () => {
    it('sends a chat.postMessage request and returns the message ts on success', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, ts: '123.456' }),
      });

      const ts = await notifier.postMessage({
        channel: 'C123',
        text: 'hello world',
      });

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledTimes(1);
      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        'https://slack.com/api/chat.postMessage',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({ channel: 'C123', text: 'hello world' }),
        }),
      );

      expect(ts).toBe('123.456');
    });

    it('suppresses threaded replies when the thread root message is gone', async () => {
      process.env.SLACK_API_BASE_URL = 'http://127.0.0.1:3012/api';

      getGlobalWithFetch().fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: false,
            error: 'thread_not_found',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ok: true, ts: 'should-not-be-used' }),
        });

      const ts = await notifier.postMessage({
        channel: 'C123',
        thread_ts: '123.000',
        text: 'hello thread',
      });

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledTimes(1);
      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:3012/api/conversations.replies?channel=C123&ts=123.000&oldest=123.000&latest=123.000&inclusive=true',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `Bearer ${token}`,
          }),
        }),
      );
      expect(ts).toBeUndefined();
    });

    it('returns undefined when Slack API returns a non-2xx response', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const ts = await notifier.postMessage({
        channel: 'C123',
        text: 'failure case',
      });

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledTimes(1);
      expect(ts).toBeUndefined();
    });

    it('returns undefined when Slack rejects the message', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, error: 'not_in_channel' }),
      });

      const ts = await notifier.postMessage({
        channel: 'C123',
        text: 'rejected case',
      });

      expect(ts).toBeUndefined();
    });

    it('does not change unfurl behavior for plain text messages', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, ts: '123.456' }),
      });

      await notifier.postMessage({
        channel: 'C123',
        text: 'Status: http://status.roomote.example/incidents/test',
      });

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        'https://slack.com/api/chat.postMessage',
        expect.objectContaining({
          body: JSON.stringify({
            channel: 'C123',
            text: 'Status: http://status.roomote.example/incidents/test',
          }),
        }),
      );
    });

    it('disables unfurls for Block Kit messages', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, ts: '123.456' }),
      });

      const blocks = [
        {
          type: 'markdown',
          text: '[status.roomote.example](http://status.roomote.example)',
        },
      ];

      await notifier.postMessage({
        channel: 'C123',
        text: 'status link',
        blocks,
      });

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        'https://slack.com/api/chat.postMessage',
        expect.objectContaining({
          body: JSON.stringify({
            channel: 'C123',
            text: 'status link',
            blocks,
            unfurl_links: false,
            unfurl_media: false,
          }),
        }),
      );
    });
  });

  describe('postMessageDetailed', () => {
    it('returns the message ts on success', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, ts: '123.456' }),
      });

      const result = await notifier.postMessageDetailed({
        channel: 'C123',
        text: 'hello world',
      });

      expect(result).toEqual({ ts: '123.456' });
    });

    it('returns the Slack error code when Slack rejects the message', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, error: 'not_in_channel' }),
      });

      const result = await notifier.postMessageDetailed({
        channel: 'C123',
        text: 'rejected case',
      });

      expect(result).toEqual({ slackErrorCode: 'not_in_channel' });
    });

    it('flags a transport error for non-2xx responses', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const result = await notifier.postMessageDetailed({
        channel: 'C123',
        text: 'failure case',
      });

      expect(result).toEqual({ transportError: true });
    });

    it('flags a skipped threaded reply when the thread root is gone', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, error: 'thread_not_found' }),
      });

      const result = await notifier.postMessageDetailed({
        channel: 'C123',
        thread_ts: '123.000',
        text: 'hello thread',
      });

      expect(result).toEqual({ skippedMissingThreadRoot: true });
    });
  });

  describe('getMessagePermalink', () => {
    it('returns the Slack permalink for a message when Slack succeeds', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          permalink:
            'https://acme-team.slack.com/archives/C123/p123456?thread_ts=123.456&cid=C123',
        }),
      });

      const permalink = await notifier.getMessagePermalink({
        channel: ' C123 ',
        messageTs: ' 123.456 ',
      });

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        'https://slack.com/api/chat.getPermalink?channel=C123&message_ts=123.456',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `Bearer ${token}`,
          }),
        }),
      );
      expect(permalink).toBe(
        'https://acme-team.slack.com/archives/C123/p123456?thread_ts=123.456&cid=C123',
      );
    });
  });

  describe('postEphemeralMessage', () => {
    it('sends a chat.postEphemeral request and returns message_ts on success', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, message_ts: '234.567' }),
      });

      const ts = await notifier.postEphemeralMessage({
        channel: 'C123',
        user: 'U123',
        text: 'ephemeral hello',
      });

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        'https://slack.com/api/chat.postEphemeral',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${token}`,
          }),
        }),
      );

      expect(ts).toBe('234.567');
    });
  });

  describe('updateMessage', () => {
    it('returns true when Slack chat.update succeeds', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      });

      const result = await notifier.updateMessage({
        channel: 'C123',
        ts: '123.000',
        message: { text: 'updated text' },
      });

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        'https://slack.com/api/chat.update',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            channel: 'C123',
            ts: '123.000',
            text: 'updated text',
          }),
        }),
      );
      expect(result).toBe(true);
    });

    it('disables unfurls for Block Kit updates', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      });

      const blocks = [
        {
          type: 'markdown',
          text: '[status.roomote.example](http://status.roomote.example)',
        },
      ];

      const result = await notifier.updateMessage({
        channel: 'C123',
        ts: '123.000',
        message: {
          text: 'updated status link',
          blocks,
        },
      });

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        'https://slack.com/api/chat.update',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            channel: 'C123',
            ts: '123.000',
            text: 'updated status link',
            blocks,
            unfurl_links: false,
            unfurl_media: false,
          }),
        }),
      );
      expect(result).toBe(true);
    });

    it('returns false when Slack chat.update returns ok: false', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, error: 'invalid_auth' }),
      });

      const result = await notifier.updateMessage({
        channel: 'C123',
        ts: '123.000',
        message: { text: 'updated text' },
      });

      expect(result).toBe(false);
    });

    it('returns false when Slack chat.update HTTP request fails', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });

      const result = await notifier.updateMessage({
        channel: 'C123',
        ts: '123.000',
        message: { text: 'updated text' },
      });

      expect(result).toBe(false);
    });
  });

  describe('deleteMessage', () => {
    it('returns true when Slack chat.delete succeeds', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      });

      const result = await notifier.deleteMessage({
        channel: 'C123',
        ts: '321.000',
      });

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        'https://slack.com/api/chat.delete',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ channel: 'C123', ts: '321.000' }),
        }),
      );
      expect(result).toBe(true);
    });

    it('returns false when Slack chat.delete fails', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, error: 'not_found' }),
      });

      const result = await notifier.deleteMessage({
        channel: 'C123',
        ts: '321.000',
      });

      expect(result).toBe(false);
    });
  });

  describe('workflow function completion', () => {
    it('completes a Slack function successfully', async () => {
      apiCallMock.mockResolvedValue({ ok: true });

      const result = await notifier.completeFunctionSuccess({
        functionExecutionId: 'Fx123',
        outputs: {
          task_id: 'task-123',
          task_url: 'https://app.roomote.dev/task/task-123',
        },
      });

      expect(result).toBe(true);
      expect(apiCallMock).toHaveBeenCalledWith('functions.completeSuccess', {
        function_execution_id: 'Fx123',
        outputs: {
          task_id: 'task-123',
          task_url: 'https://app.roomote.dev/task/task-123',
        },
      });
    });

    it('fails a Slack function execution', async () => {
      apiCallMock.mockResolvedValue({ ok: true });

      const result = await notifier.completeFunctionError({
        functionExecutionId: 'Fx123',
        error: 'Roomote could not determine a workspace for this message.',
      });

      expect(result).toBe(true);
      expect(apiCallMock).toHaveBeenCalledWith('functions.completeError', {
        function_execution_id: 'Fx123',
        error: 'Roomote could not determine a workspace for this message.',
      });
    });
  });

  describe('addReaction', () => {
    it('adds a reaction when Slack reactions.add succeeds', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      });

      const result = await notifier.addReaction({
        channel: 'C123',
        timestamp: '123.000',
        name: 'eyes',
      });

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        'https://slack.com/api/reactions.add',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            channel: 'C123',
            timestamp: '123.000',
            name: 'eyes',
          }),
        }),
      );
      expect(result).toBe(true);
    });

    it('returns false when Slack reactions.add fails', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, error: 'channel_not_found' }),
      });

      const result = await notifier.addReaction({
        channel: 'C123',
        timestamp: '123.000',
        name: 'eyes',
      });

      expect(result).toBe(false);
    });
  });

  describe('removeReaction', () => {
    it('removes a reaction when Slack reactions.remove succeeds', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      });

      const result = await notifier.removeReaction({
        channel: 'C123',
        timestamp: '123.000',
        name: 'eyes',
      });

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        'https://slack.com/api/reactions.remove',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            channel: 'C123',
            timestamp: '123.000',
            name: 'eyes',
          }),
        }),
      );
      expect(result).toBe(true);
    });

    it('returns false when Slack reactions.remove fails', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, error: 'no_reaction' }),
      });

      const result = await notifier.removeReaction({
        channel: 'C123',
        timestamp: '123.000',
        name: 'eyes',
      });

      expect(result).toBe(false);
    });

    it('returns false when fetch throws an error', async () => {
      getGlobalWithFetch().fetch = vi
        .fn()
        .mockRejectedValue(new Error('network error'));

      const result = await notifier.removeReaction({
        channel: 'C123',
        timestamp: '123.000',
        name: 'eyes',
      });

      expect(result).toBe(false);
    });
  });

  describe('isAppInChannel', () => {
    it('returns true when Slack reports the app is a channel member', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          channel: { is_member: true },
        }),
      });

      const result = await notifier.isAppInChannel('C123');

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        'https://slack.com/api/conversations.info?channel=C123',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `Bearer ${token}`,
          }),
          // Every Slack call is bounded by a timeout signal.
          signal: expect.any(AbortSignal),
        }),
      );
      expect(result).toBe(true);
    });

    it('returns false when Slack reports the app is not in the channel', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          channel: { is_member: false },
        }),
      });

      const result = await notifier.isAppInChannel('C123');

      expect(result).toBe(false);
    });

    it('returns false when Slack cannot access the channel', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: false,
          error: 'channel_not_found',
        }),
      });

      const result = await notifier.isAppInChannel('C123');

      expect(result).toBe(false);
    });
  });

  describe('isPublicChannel', () => {
    it('returns true when Slack reports a public channel', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          channel: { is_private: false },
        }),
      });

      const result = await notifier.isPublicChannel('C123');

      expect(result).toBe(true);
    });

    it('returns false when Slack reports a private channel', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          channel: { is_private: true },
        }),
      });

      const result = await notifier.isPublicChannel('C123');

      expect(result).toBe(false);
    });
  });

  describe('getChannelName', () => {
    it('returns the Slack channel name for a channel ID', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          channel: { name: 'roomote-managers' },
        }),
      });

      const result = await notifier.getChannelName('C123');

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        'https://slack.com/api/conversations.info?channel=C123',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `Bearer ${token}`,
          }),
        }),
      );
      expect(result).toBe('roomote-managers');
    });

    it('returns null when Slack cannot resolve the channel name', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: false,
          error: 'channel_not_found',
        }),
      });

      await expect(notifier.getChannelName('C123')).resolves.toBeNull();
    });
  });

  describe('isUserInChannel', () => {
    it('returns true when the user is present in the channel member list', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          members: ['U111', 'U123'],
          response_metadata: { next_cursor: '' },
        }),
      });

      const result = await notifier.isUserInChannel({
        channelId: 'C123',
        userId: 'U123',
      });

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        'https://slack.com/api/conversations.members?channel=C123&limit=200',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `Bearer ${token}`,
          }),
        }),
      );
      expect(result).toBe(true);
    });

    it('returns false when the user is missing from every page of members', async () => {
      getGlobalWithFetch().fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            members: ['U111'],
            response_metadata: { next_cursor: 'cursor-2' },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            members: ['U222'],
            response_metadata: { next_cursor: '' },
          }),
        });

      const result = await notifier.isUserInChannel({
        channelId: 'C123',
        userId: 'U123',
      });

      expect(result).toBe(false);
      expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
        2,
        'https://slack.com/api/conversations.members?channel=C123&limit=200&cursor=cursor-2',
        expect.any(Object),
      );
    });

    it('returns false when Slack cannot access the channel member list', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: false,
          error: 'not_in_channel',
        }),
      });

      const result = await notifier.isUserInChannel({
        channelId: 'C123',
        userId: 'U123',
      });

      expect(result).toBe(false);
    });
  });

  describe('getWorkspaceMemberCount', () => {
    it('counts active human members across paginated users.list results', async () => {
      getGlobalWithFetch().fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            members: [
              { id: 'U111' },
              { id: 'USLACKBOT' },
              { id: 'B111', is_bot: true },
              { id: 'U222', deleted: true },
            ],
            response_metadata: { next_cursor: 'cursor-2' },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            members: [{ id: 'U333' }, { id: 'U444' }],
            response_metadata: { next_cursor: '' },
          }),
        });

      const result = await notifier.getWorkspaceMemberCount();

      expect(result).toBe(3);
      expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
        1,
        'https://slack.com/api/users.list?limit=999',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `Bearer ${token}`,
          }),
        }),
      );
      expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
        2,
        'https://slack.com/api/users.list?limit=999&cursor=cursor-2',
        expect.any(Object),
      );
    });

    it('retries users.list after a rate limit response', async () => {
      vi.useFakeTimers();

      try {
        getGlobalWithFetch().fetch = vi
          .fn()
          .mockResolvedValueOnce({
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            headers: {
              get: (name: string) => (name === 'Retry-After' ? '1.5' : null),
            },
          })
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              ok: true,
              members: [{ id: 'U111' }],
              response_metadata: { next_cursor: '' },
            }),
          });

        const resultPromise = notifier.getWorkspaceMemberCount();

        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1500);

        await expect(resultPromise).resolves.toBe(1);
        expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
          1,
          'https://slack.com/api/users.list?limit=999',
          expect.any(Object),
        );
        expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
          2,
          'https://slack.com/api/users.list?limit=999',
          expect.any(Object),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns null when Slack rejects the users.list request', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: false,
          error: 'missing_scope',
        }),
      });

      const result = await notifier.getWorkspaceMemberCount();

      expect(result).toBeNull();
    });
  });

  describe('processSlackFiles', () => {
    it('filters non-image and oversized files and returns data URLs for valid images', async () => {
      const smallImage: SlackFile = {
        id: 'F1',
        name: 'image.png',
        mimetype: 'image/png',
        filetype: 'png',
        url_private: 'https://files.slack.com/F1',
        url_private_download: 'https://files.slack.com/F1/download',
        size: 1024,
      };

      const largeImage: SlackFile = {
        ...smallImage,
        id: 'F2',
        size: 11 * 1024 * 1024, // > 10MB
      };

      const textFile: SlackFile = {
        ...smallImage,
        id: 'F3',
        name: 'notes.txt',
        mimetype: 'text/plain',
        filetype: 'txt',
      };

      const svgFile: SlackFile = {
        ...smallImage,
        id: 'F4',
        name: 'diagram.svg',
        mimetype: 'image/svg+xml',
        filetype: 'svg',
      };

      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode('fake-image').buffer,
      });

      const images = await notifier.processSlackFiles([
        smallImage,
        largeImage,
        textFile,
        svgFile,
      ]);

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledTimes(1);
      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        smallImage.url_private_download,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${token}`,
          }),
        }),
      );

      expect(images).toHaveLength(1);
      expect(images[0]).toMatch(/^data:image\/png;base64,/);
    });
  });

  describe('downloadSlackFile', () => {
    it('downloads a Slack file with bot auth and returns bytes', async () => {
      const file: SlackFile = {
        id: 'F1',
        name: 'recording.mp4',
        mimetype: 'video/mp4',
        filetype: 'mp4',
        url_private: 'https://files.slack.com/F1',
        url_private_download: 'https://files.slack.com/F1/download',
        size: 1024,
      };

      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode('video-bytes').buffer,
      });

      const fileBytes = await notifier.downloadSlackFile(file);

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        file.url_private_download,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${token}`,
          }),
        }),
      );
      expect(fileBytes).toEqual(Buffer.from('video-bytes'));
    });
  });

  describe('hasMessageInThread', () => {
    it('returns true when the target message is present in the thread lookup', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          messages: [{ ts: '111.000' }],
        }),
      });

      const result = await notifier.hasMessageInThread({
        channel: 'C123',
        threadTs: '111.000',
        messageTs: '111.000',
      });

      expect(result).toBe(true);
    });

    it('returns false when Slack reports the thread message was not found', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: false,
          error: 'message_not_found',
        }),
      });

      const result = await notifier.hasMessageInThread({
        channel: 'C123',
        threadTs: '111.000',
        messageTs: '111.000',
      });

      expect(result).toBe(false);
    });

    it('returns null when the Slack API request itself fails', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Error',
      });

      const result = await notifier.hasMessageInThread({
        channel: 'C123',
        threadTs: '111.000',
        messageTs: '111.000',
      });

      expect(result).toBeNull();
    });

    it('retries transient conversations.replies rate limits before returning success', async () => {
      vi.useFakeTimers();

      try {
        getGlobalWithFetch().fetch = vi
          .fn()
          .mockResolvedValueOnce({
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            headers: {
              get: (name: string) => (name === 'Retry-After' ? '1.5' : null),
            },
          })
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              ok: true,
              messages: [{ ts: '111.000' }],
            }),
          });

        const resultPromise = notifier.hasMessageInThread({
          channel: 'C123',
          threadTs: '111.000',
          messageTs: '111.000',
        });

        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1500);

        await expect(resultPromise).resolves.toBe(true);
        expect(getGlobalWithFetch().fetch).toHaveBeenCalledTimes(2);
        expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
          1,
          'https://slack.com/api/conversations.replies?channel=C123&ts=111.000&oldest=111.000&latest=111.000&inclusive=true',
          expect.any(Object),
        );
        expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
          2,
          'https://slack.com/api/conversations.replies?channel=C123&ts=111.000&oldest=111.000&latest=111.000&inclusive=true',
          expect.any(Object),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('getMessageMetadata', () => {
    it('returns message metadata when Slack includes it on the message', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          messages: [
            {
              ts: '123.456',
              metadata: {
                event_type: 'roomote.setup_onboarding_suggestion',
                event_payload: {
                  sourceTaskId: 'task-suggestions-1',
                  suggestionId: 'suggestion-1',
                },
              },
            },
          ],
        }),
      });

      const metadata = await notifier.getMessageMetadata({
        channel: 'C123',
        messageTs: '123.456',
      });

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        'https://slack.com/api/conversations.history?channel=C123&oldest=123.456&latest=123.456&inclusive=true&limit=1&include_all_metadata=true',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `Bearer ${token}`,
          }),
        }),
      );
      expect(metadata).toEqual({
        event_type: 'roomote.setup_onboarding_suggestion',
        event_payload: {
          sourceTaskId: 'task-suggestions-1',
          suggestionId: 'suggestion-1',
        },
      });
    });

    it('returns null when Slack returns the target message without metadata', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          messages: [{ ts: '123.456' }],
        }),
      });

      const metadata = await notifier.getMessageMetadata({
        channel: 'C123',
        messageTs: '123.456',
      });

      expect(metadata).toBeNull();
    });

    it('falls back to thread replies metadata when channel history has no metadata for a thread reply', async () => {
      getGlobalWithFetch().fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            messages: [{ ts: '123.456' }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                ts: '123.456',
                metadata: {
                  event_type: 'roomote.thread_reply_details',
                  event_payload: {
                    taskId: 'task-1',
                    detailId: 'detail-1',
                  },
                },
              },
            ],
          }),
        });

      const metadata = await notifier.getMessageMetadata({
        channel: 'C123',
        threadTs: '111.222',
        messageTs: '123.456',
      });

      expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
        2,
        'https://slack.com/api/conversations.replies?channel=C123&ts=111.222&oldest=123.456&latest=123.456&inclusive=true&include_all_metadata=true',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `Bearer ${token}`,
          }),
        }),
      );
      expect(metadata).toEqual({
        event_type: 'roomote.thread_reply_details',
        event_payload: {
          taskId: 'task-1',
          detailId: 'detail-1',
        },
      });
    });
  });

  describe('getMessage', () => {
    it('returns a single source message with text, files, and thread metadata', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          messages: [
            {
              ts: '123.456',
              text: 'Ship it',
              thread_ts: '120.000',
              user: 'U123',
              attachments: [
                {
                  fallback: 'Forwarded from #support',
                  text: 'Forwarded body lives here',
                },
              ],
              files: [
                {
                  id: 'file-1',
                  name: 'spec.png',
                  mimetype: 'image/png',
                  filetype: 'png',
                  url_private: 'https://files.slack.com/spec.png',
                  url_private_download:
                    'https://files.slack.com/spec-download.png',
                  size: 123,
                },
              ],
            },
          ],
        }),
      });

      const message = await notifier.getMessage({
        channel: 'C123',
        messageTs: '123.456',
      });

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        'https://slack.com/api/conversations.history?channel=C123&oldest=123.456&latest=123.456&inclusive=true&limit=1',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `Bearer ${token}`,
          }),
        }),
      );
      expect(message).toEqual({
        text: 'Ship it',
        ts: '123.456',
        thread_ts: '120.000',
        user: 'U123',
        bot_id: undefined,
        app_id: undefined,
        attachments: [
          {
            fallback: 'Forwarded from #support',
            text: 'Forwarded body lives here',
          },
        ],
        files: [
          {
            id: 'file-1',
            name: 'spec.png',
            mimetype: 'image/png',
            filetype: 'png',
            url_private: 'https://files.slack.com/spec.png',
            url_private_download: 'https://files.slack.com/spec-download.png',
            size: 123,
          },
        ],
      });
    });

    it('adds forwarded Slack attachment text to source messages', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          messages: [
            {
              ts: '123.456',
              text: 'can you see this?',
              user: 'U123',
              attachments: [
                {
                  is_share: true,
                  is_msg_unfurl: true,
                  text: 'Forwarded body',
                  author_name: 'Annie Easley',
                  channel_id: 'C0EXAMPLE01',
                },
              ],
            },
          ],
        }),
      });

      const message = await notifier.getMessage({
        channel: 'C123',
        messageTs: '123.456',
      });

      expect(message?.text).toBe(
        [
          'can you see this?',
          '',
          'Forwarded Slack message:',
          'Context:',
          '- Author: Annie Easley',
          '- Channel: C0EXAMPLE01',
          'Text:',
          'Forwarded body',
        ].join('\n'),
      );
    });

    it('adds forwarded Slack image files to source messages', async () => {
      const forwardedImage: SlackFile = {
        id: 'F-forwarded',
        name: 'forwarded.png',
        mimetype: 'image/png',
        filetype: 'png',
        url_private: 'https://files.slack.com/F-forwarded',
        url_private_download: 'https://files.slack.com/F-forwarded/download',
        size: 1_024,
      };

      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          messages: [
            {
              ts: '123.456',
              text: 'can you use this screenshot?',
              user: 'U123',
              attachments: [
                {
                  is_share: true,
                  message_blocks: [
                    {
                      message: {
                        files: [forwardedImage],
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      });

      const message = await notifier.getMessage({
        channel: 'C123',
        messageTs: '123.456',
      });

      expect(message?.files).toEqual([forwardedImage]);
    });

    it('preserves app_id for app-authored source messages', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          messages: [
            {
              ts: '123.456',
              text: 'Automated reminder',
              bot_id: 'B_EXTERNAL',
              app_id: 'A_ROOMOTE',
            },
          ],
        }),
      });

      const message = await notifier.getMessage({
        channel: 'C123',
        messageTs: '123.456',
      });

      expect(message).toEqual({
        text: 'Automated reminder',
        ts: '123.456',
        thread_ts: undefined,
        user: undefined,
        bot_id: 'B_EXTERNAL',
        app_id: 'A_ROOMOTE',
        attachments: undefined,
        files: undefined,
      });
    });

    it('returns null when Slack cannot return the source message text', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          messages: [{ ts: '123.456' }],
        }),
      });

      const message = await notifier.getMessage({
        channel: 'C123',
        messageTs: '123.456',
      });

      expect(message).toBeNull();
    });

    it('falls back to conversations.replies when channel history misses a thread reply', async () => {
      getGlobalWithFetch().fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            messages: [],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                ts: '123.456',
                text: 'Reply message',
                thread_ts: '120.000',
                user: 'U789',
              },
            ],
          }),
        });

      const message = await notifier.getMessage({
        channel: 'C123',
        messageTs: '123.456',
      });

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledTimes(2);
      expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
        1,
        'https://slack.com/api/conversations.history?channel=C123&oldest=123.456&latest=123.456&inclusive=true&limit=1',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `Bearer ${token}`,
          }),
        }),
      );
      expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
        2,
        'https://slack.com/api/conversations.replies?channel=C123&ts=123.456&oldest=123.456&latest=123.456&inclusive=true',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `Bearer ${token}`,
          }),
        }),
      );
      expect(message).toEqual({
        text: 'Reply message',
        ts: '123.456',
        thread_ts: '120.000',
        user: 'U789',
        bot_id: undefined,
        app_id: undefined,
        attachments: undefined,
        files: undefined,
      });
    });
  });

  describe('fetchThreadMessages', () => {
    it('fetches thread messages and enriches them with user display names', async () => {
      const getUsersInfoSpy = vi
        .spyOn(
          SlackNotifier.prototype as unknown as {
            getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
          },
          'getUsersInfo',
        )
        .mockResolvedValue(new Map([['U123', 'Alice']]));

      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          messages: [
            {
              user: 'U123',
              text: 'hello',
              ts: '111.000',
              type: 'message',
            },
            {
              user: 'U999',
              text: '',
              ts: '112.000',
              type: 'message',
            },
          ],
        }),
      });

      const messages = await notifier.fetchThreadMessages({
        channel: 'C123',
        threadTs: '111.000',
      });

      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        expect.stringContaining('conversations.replies'),
        expect.objectContaining({ method: 'GET' }),
      );

      expect(getUsersInfoSpy).toHaveBeenCalledWith(['U123']);
      expect(messages).toEqual([
        expect.objectContaining({
          user: 'U123',
          username: 'Alice',
          text: 'hello',
          ts: '111.000',
        }),
      ]);
    });

    it('strips suggestion reaction starter notices from reread thread text', async () => {
      const getUsersInfoSpy = vi
        .spyOn(
          SlackNotifier.prototype as unknown as {
            getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
          },
          'getUsersInfo',
        )
        .mockResolvedValue(new Map());

      getGlobalWithFetch().fetch = vi.fn().mockImplementation(async (input) => {
        const url = String(input);

        if (url.includes('auth.test')) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              bot_id: 'B123',
            }),
          };
        }

        return {
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                bot_id: 'B123',
                username: 'Roomote Bot',
                text: '**Idea 1: Fix flaky login**\nFix flaky login\n\nAccepted by <@U999>',
                ts: '111.000',
                type: 'message',
              },
            ],
          }),
        };
      });

      const messages = await notifier.fetchThreadMessages({
        channel: 'C123',
        threadTs: '111.000',
      });

      expect(getUsersInfoSpy).not.toHaveBeenCalled();
      expect(messages).toEqual([
        expect.objectContaining({
          user: 'B123',
          username: 'Roomote Bot',
          text: '**Idea 1: Fix flaky login**\nFix flaky login',
          ts: '111.000',
        }),
      ]);
    });

    it('strips suggestion footer text when Slack returns our own bot reply as the bot user', async () => {
      const getUsersInfoSpy = vi
        .spyOn(
          SlackNotifier.prototype as unknown as {
            getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
          },
          'getUsersInfo',
        )
        .mockResolvedValue(new Map([['U_ROOMOTE', 'Roomote Bot']]));

      getGlobalWithFetch().fetch = vi.fn().mockImplementation(async (input) => {
        const url = String(input);

        if (url.includes('auth.test')) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              user_id: 'U_ROOMOTE',
              bot_id: 'B123',
            }),
          };
        }

        return {
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                user: 'U_ROOMOTE',
                username: 'Roomote Bot',
                text: '**Idea 1: Fix flaky login**\nFix flaky login\n\nAccepted by <@U999>',
                ts: '111.010',
                type: 'message',
              },
            ],
          }),
        };
      });

      const messages = await notifier.fetchThreadMessages({
        channel: 'C123',
        threadTs: '111.010',
      });

      expect(getUsersInfoSpy).toHaveBeenCalledWith(['U_ROOMOTE']);
      expect(messages).toEqual([
        expect.objectContaining({
          user: 'U_ROOMOTE',
          text: '**Idea 1: Fix flaky login**\nFix flaky login',
          ts: '111.010',
        }),
      ]);
    });

    it('does not strip a human-authored accepted footer lookalike', async () => {
      const getUsersInfoSpy = vi
        .spyOn(
          SlackNotifier.prototype as unknown as {
            getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
          },
          'getUsersInfo',
        )
        .mockResolvedValue(new Map([['U123', 'Alice']]));

      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          messages: [
            {
              user: 'U123',
              text: 'Please leave this note intact.\n\nAccepted by <@U999>',
              ts: '111.001',
              type: 'message',
            },
          ],
        }),
      });

      const messages = await notifier.fetchThreadMessages({
        channel: 'C123',
        threadTs: '111.001',
      });

      expect(getUsersInfoSpy).toHaveBeenCalledWith(['U123']);
      expect(messages).toEqual([
        expect.objectContaining({
          user: 'U123',
          username: 'Alice',
          text: 'Please leave this note intact.\n\nAccepted by <@U999>',
          ts: '111.001',
        }),
      ]);
    });

    it('does not strip a third-party bot accepted footer lookalike', async () => {
      const getUsersInfoSpy = vi
        .spyOn(
          SlackNotifier.prototype as unknown as {
            getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
          },
          'getUsersInfo',
        )
        .mockResolvedValue(new Map());

      getGlobalWithFetch().fetch = vi.fn().mockImplementation(async (input) => {
        const url = String(input);

        if (url.includes('auth.test')) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              bot_id: 'B123',
            }),
          };
        }

        return {
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                bot_id: 'B999',
                username: 'Deploy Bot',
                text: 'Deployment posted.\n\nAccepted by <@U999>',
                ts: '111.002',
                type: 'message',
              },
            ],
          }),
        };
      });

      const messages = await notifier.fetchThreadMessages({
        channel: 'C123',
        threadTs: '111.002',
      });

      expect(getUsersInfoSpy).not.toHaveBeenCalled();
      expect(messages).toEqual([
        expect.objectContaining({
          user: 'B999',
          username: 'Deploy Bot',
          text: 'Deployment posted.\n\nAccepted by <@U999>',
          ts: '111.002',
        }),
      ]);
    });

    it('uses bot-provided display names for bot thread messages', async () => {
      const getUsersInfoSpy = vi.spyOn(
        SlackNotifier.prototype as unknown as {
          getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
        },
        'getUsersInfo',
      );

      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          messages: [
            {
              user: 'Ubot',
              text: 'hello from the bot',
              ts: '111.000',
              type: 'message',
              bot_id: 'B123',
              username: 'Roomote Bot',
            },
            {
              user: 'Ubot2',
              text: 'hello from bot profile',
              ts: '112.000',
              type: 'message',
              bot_id: 'B456',
              bot_profile: { name: 'Escalation Bot' },
            },
          ],
        }),
      });

      const messages = await notifier.fetchThreadMessages({
        channel: 'C123',
        threadTs: '111.000',
      });

      expect(getUsersInfoSpy).not.toHaveBeenCalled();
      expect(messages).toEqual([
        expect.objectContaining({
          user: 'Ubot',
          username: 'Roomote Bot',
          text: 'hello from the bot',
          ts: '111.000',
          bot_id: 'B123',
        }),
        expect.objectContaining({
          user: 'Ubot2',
          username: 'Escalation Bot',
          text: 'hello from bot profile',
          ts: '112.000',
          bot_id: 'B456',
        }),
      ]);
    });

    it('returns Roomote bot messages by default when no filtering opt-in is requested', async () => {
      const getUsersInfoSpy = vi
        .spyOn(
          SlackNotifier.prototype as unknown as {
            getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
          },
          'getUsersInfo',
        )
        .mockResolvedValue(new Map([['U123', 'Alice']]));

      getGlobalWithFetch().fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          messages: [
            {
              user: 'U123',
              text: 'hello',
              ts: '111.000',
              type: 'message',
            },
            {
              user: 'Uroomote',
              text: 'working on it',
              ts: '112.000',
              type: 'message',
              bot_id: 'B_ROOMOTE',
              username: 'Roomote Bot',
            },
            {
              user: 'Ubot2',
              text: 'other bot update',
              ts: '113.000',
              type: 'message',
              bot_id: 'B_OTHER',
              username: 'Deploy Bot',
            },
          ],
        }),
      });

      const messages = await notifier.fetchThreadMessages({
        channel: 'C123',
        threadTs: '111.000',
      });

      expect(getUsersInfoSpy).toHaveBeenCalledWith(['U123']);
      expect(messages).toEqual([
        expect.objectContaining({
          user: 'U123',
          username: 'Alice',
          text: 'hello',
          ts: '111.000',
        }),
        expect.objectContaining({
          user: 'Uroomote',
          username: 'Roomote Bot',
          text: 'working on it',
          ts: '112.000',
          bot_id: 'B_ROOMOTE',
        }),
        expect.objectContaining({
          user: 'Ubot2',
          username: 'Deploy Bot',
          text: 'other bot update',
          ts: '113.000',
          bot_id: 'B_OTHER',
        }),
      ]);
      expect(getGlobalWithFetch().fetch).toHaveBeenCalledTimes(1);
      expect(getGlobalWithFetch().fetch).toHaveBeenCalledWith(
        expect.stringContaining('conversations.replies'),
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it("filters out Roomote's own bot messages only when opt-in filtering is requested", async () => {
      const getUsersInfoSpy = vi
        .spyOn(
          SlackNotifier.prototype as unknown as {
            getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
          },
          'getUsersInfo',
        )
        .mockResolvedValue(new Map([['U123', 'Alice']]));

      getGlobalWithFetch().fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                user: 'U123',
                text: 'first',
                ts: '111.000',
                type: 'message',
              },
              {
                user: 'Uroomote',
                text: 'working on it',
                ts: '112.000',
                type: 'message',
                bot_id: 'B_ROOMOTE',
                username: 'Roomote Bot',
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            user_id: 'U_ROOMOTE',
            bot_id: 'B_ROOMOTE',
          }),
        });

      const messages = await notifier.fetchThreadMessages({
        channel: 'C123',
        threadTs: '111.000',
        excludeOwnBot: true,
      });

      expect(getUsersInfoSpy).toHaveBeenCalledWith(['U123']);
      expect(messages).toEqual([
        expect.objectContaining({
          user: 'U123',
          username: 'Alice',
          text: 'first',
          ts: '111.000',
        }),
      ]);
      expect(getGlobalWithFetch().fetch).toHaveBeenCalledTimes(2);
      expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('conversations.replies'),
        expect.objectContaining({ method: 'GET' }),
      );
      expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('auth.test'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('keeps human replies when auth.test returns only the bot user id', async () => {
      const getUsersInfoSpy = vi
        .spyOn(
          SlackNotifier.prototype as unknown as {
            getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
          },
          'getUsersInfo',
        )
        .mockResolvedValue(
          new Map([
            ['U123', 'Alice'],
            ['U_ROOMOTE', 'Roomote Bot'],
          ]),
        );

      getGlobalWithFetch().fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                user: 'U123',
                text: 'first',
                ts: '111.000',
                type: 'message',
              },
              {
                user: 'U_ROOMOTE',
                text: 'working on it',
                ts: '112.000',
                type: 'message',
                username: 'Roomote Bot',
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            user_id: 'U_ROOMOTE',
          }),
        });

      const messages = await notifier.fetchThreadMessages({
        channel: 'C123',
        threadTs: '111.000',
        excludeOwnBot: true,
      });

      expect(getUsersInfoSpy).toHaveBeenCalledWith(['U123']);
      expect(messages).toEqual([
        expect.objectContaining({
          user: 'U123',
          username: 'Alice',
          text: 'first',
          ts: '111.000',
        }),
      ]);
      expect(getGlobalWithFetch().fetch).toHaveBeenCalledTimes(2);
      expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('auth.test'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('caches auth.test bot identity lookups per notifier instance when filtering is enabled', async () => {
      const getUsersInfoSpy = vi
        .spyOn(
          SlackNotifier.prototype as unknown as {
            getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
          },
          'getUsersInfo',
        )
        .mockResolvedValue(new Map([['U123', 'Alice']]));

      getGlobalWithFetch().fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                user: 'U123',
                text: 'first',
                ts: '111.000',
                type: 'message',
              },
              {
                user: 'Uroomote',
                text: 'working on it',
                ts: '112.000',
                type: 'message',
                bot_id: 'B_ROOMOTE',
                username: 'Roomote Bot',
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            user_id: 'U_ROOMOTE',
            bot_id: 'B_ROOMOTE',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                user: 'U123',
                text: 'second',
                ts: '121.000',
                type: 'message',
              },
              {
                user: 'Uroomote',
                text: 'still working on it',
                ts: '122.000',
                type: 'message',
                bot_id: 'B_ROOMOTE',
                username: 'Roomote Bot',
              },
            ],
          }),
        });

      await notifier.fetchThreadMessages({
        channel: 'C123',
        threadTs: '111.000',
        excludeOwnBot: true,
      });
      await notifier.fetchThreadMessages({
        channel: 'C123',
        threadTs: '121.000',
        excludeOwnBot: true,
      });

      expect(getUsersInfoSpy).toHaveBeenNthCalledWith(1, ['U123']);
      expect(getUsersInfoSpy).toHaveBeenNthCalledWith(2, ['U123']);
      expect(getGlobalWithFetch().fetch).toHaveBeenCalledTimes(3);
      expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('conversations.replies'),
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('retries auth.test after a transient bot identity lookup failure', async () => {
      const getUsersInfoSpy = vi
        .spyOn(
          SlackNotifier.prototype as unknown as {
            getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
          },
          'getUsersInfo',
        )
        .mockResolvedValue(new Map([['U_ROOMOTE', 'Roomote Bot']]));

      getGlobalWithFetch().fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                user: 'U_ROOMOTE',
                username: 'Roomote Bot',
                text: '**Idea 1**\nFix flaky login\n\nAccepted by <@U999>',
                ts: '111.100',
                type: 'message',
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                user: 'U_ROOMOTE',
                username: 'Roomote Bot',
                text: '**Idea 2**\nFix retry path\n\nAccepted by <@U999>',
                ts: '111.101',
                type: 'message',
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            user_id: 'U_ROOMOTE',
            bot_id: 'B123',
          }),
        });

      const firstMessages = await notifier.fetchThreadMessages({
        channel: 'C123',
        threadTs: '111.100',
      });
      const secondMessages = await notifier.fetchThreadMessages({
        channel: 'C123',
        threadTs: '111.101',
      });

      expect(getUsersInfoSpy).toHaveBeenNthCalledWith(1, ['U_ROOMOTE']);
      expect(getUsersInfoSpy).toHaveBeenNthCalledWith(2, ['U_ROOMOTE']);
      expect(firstMessages).toEqual([
        expect.objectContaining({
          text: '**Idea 1**\nFix flaky login\n\nAccepted by <@U999>',
          ts: '111.100',
        }),
      ]);
      expect(secondMessages).toEqual([
        expect.objectContaining({
          text: '**Idea 2**\nFix retry path',
          ts: '111.101',
        }),
      ]);
      expect(getGlobalWithFetch().fetch).toHaveBeenCalledTimes(4);
      expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('auth.test'),
        expect.objectContaining({ method: 'POST' }),
      );
      expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
        4,
        expect.stringContaining('auth.test'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('passes through thread message files when Slack includes them', async () => {
      const getUsersInfoSpy = vi
        .spyOn(
          SlackNotifier.prototype as unknown as {
            getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
          },
          'getUsersInfo',
        )
        .mockResolvedValue(new Map([['U123', 'Alice']]));

      const imageFile: SlackFile = {
        id: 'F123',
        name: 'screenshot.png',
        mimetype: 'image/png',
        filetype: 'png',
        url_private: 'https://files.slack.com/F123',
        url_private_download: 'https://files.slack.com/F123/download',
        size: 1024,
      };

      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          messages: [
            {
              user: 'U123',
              text: 'see attached',
              ts: '111.000',
              type: 'message',
              files: [imageFile],
            },
          ],
        }),
      });

      const messages = await notifier.fetchThreadMessages({
        channel: 'C123',
        threadTs: '111.000',
      });

      expect(getUsersInfoSpy).toHaveBeenCalledWith(['U123']);
      expect(messages).toEqual([
        expect.objectContaining({
          user: 'U123',
          username: 'Alice',
          text: 'see attached',
          ts: '111.000',
          files: [imageFile],
        }),
      ]);
    });

    it('adds forwarded Slack attachment text to thread messages', async () => {
      const getUsersInfoSpy = vi
        .spyOn(
          SlackNotifier.prototype as unknown as {
            getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
          },
          'getUsersInfo',
        )
        .mockResolvedValue(new Map([['U123', 'Alice']]));

      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          messages: [
            {
              user: 'U123',
              text: 'can you see this?',
              ts: '111.000',
              type: 'message',
              attachments: [
                {
                  is_share: true,
                  text: 'Forwarded thread body',
                  author_name: 'Bob',
                },
              ],
            },
          ],
        }),
      });

      const messages = await notifier.fetchThreadMessages({
        channel: 'C123',
        threadTs: '111.000',
      });

      expect(getUsersInfoSpy).toHaveBeenCalledWith(['U123']);
      expect(messages[0]?.text).toBe(
        [
          'can you see this?',
          '',
          'Forwarded Slack message:',
          'Context:',
          '- Author: Bob',
          'Text:',
          'Forwarded thread body',
        ].join('\n'),
      );
    });

    it('adds forwarded Slack image files to thread messages', async () => {
      const getUsersInfoSpy = vi
        .spyOn(
          SlackNotifier.prototype as unknown as {
            getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
          },
          'getUsersInfo',
        )
        .mockResolvedValue(new Map([['U123', 'Alice']]));

      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          messages: [
            {
              user: 'U123',
              text: '',
              ts: '111.000',
              type: 'message',
              attachments: [
                {
                  is_msg_unfurl: true,
                  image_url: 'https://files.slack.com/forwarded-thread.png',
                  image_bytes: 1_024,
                },
              ],
            },
          ],
        }),
      });

      const messages = await notifier.fetchThreadMessages({
        channel: 'C123',
        threadTs: '111.000',
      });

      expect(getUsersInfoSpy).toHaveBeenCalledWith(['U123']);
      expect(messages).toEqual([
        expect.objectContaining({
          user: 'U123',
          username: 'Alice',
          text: '',
          ts: '111.000',
          files: [
            expect.objectContaining({
              id: expect.stringMatching(/^forwarded-/),
              mimetype: 'image/png',
              url_private_download:
                'https://files.slack.com/forwarded-thread.png',
            }),
          ],
        }),
      ]);
    });

    it('keeps screenshot-only replies when files are present but text is empty', async () => {
      const getUsersInfoSpy = vi
        .spyOn(
          SlackNotifier.prototype as unknown as {
            getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
          },
          'getUsersInfo',
        )
        .mockResolvedValue(new Map([['U123', 'Alice']]));

      const imageFile: SlackFile = {
        id: 'F124',
        name: 'thread-shot.png',
        mimetype: 'image/png',
        filetype: 'png',
        url_private: 'https://files.slack.com/F124',
        url_private_download: 'https://files.slack.com/F124/download',
        size: 1024,
      };

      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          messages: [
            {
              user: 'U123',
              text: '',
              ts: '111.000',
              type: 'message',
              files: [imageFile],
            },
          ],
        }),
      });

      const messages = await notifier.fetchThreadMessages({
        channel: 'C123',
        threadTs: '111.000',
      });

      expect(getUsersInfoSpy).toHaveBeenCalledWith(['U123']);
      expect(messages).toEqual([
        expect.objectContaining({
          user: 'U123',
          username: 'Alice',
          text: '',
          ts: '111.000',
          files: [imageFile],
        }),
      ]);
    });

    it('returns an empty array when Slack conversations.replies fails', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Error',
      });

      const messages = await notifier.fetchThreadMessages({
        channel: 'C123',
        threadTs: '111.000',
      });

      expect(messages).toEqual([]);
    });
  });

  describe('fetchChannelMessages', () => {
    it('paginates channel history and expands thread replies', async () => {
      const getUsersInfoSpy = vi
        .spyOn(
          SlackNotifier.prototype as unknown as {
            getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
          },
          'getUsersInfo',
        )
        .mockResolvedValue(
          new Map([
            ['U123', 'Alice'],
            ['U234', 'Bob'],
            ['U345', 'Carol'],
          ]),
        );

      getGlobalWithFetch().fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                user: 'U123',
                text: 'root',
                ts: '111.000',
                thread_ts: '111.000',
                reply_count: 1,
                type: 'message',
              },
              {
                user: 'U345',
                text: 'later top-level',
                ts: '113.000',
                type: 'message',
              },
            ],
            response_metadata: {
              next_cursor: 'cursor-1',
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                user: 'U123',
                text: 'earlier top-level',
                ts: '110.000',
                type: 'message',
              },
            ],
            response_metadata: {},
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                user: 'U123',
                text: 'root',
                ts: '111.000',
                thread_ts: '111.000',
                type: 'message',
              },
              {
                user: 'U234',
                text: 'reply',
                ts: '112.000',
                thread_ts: '111.000',
                type: 'message',
              },
            ],
          }),
        });

      const messages = await notifier.fetchChannelMessages({
        channel: 'C123',
        oldest: '110.000',
        latest: '113.000',
      });

      expect(getUsersInfoSpy).toHaveBeenCalled();
      expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
        1,
        'https://slack.com/api/conversations.history?channel=C123&limit=200&inclusive=true&latest=113.000',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
        2,
        'https://slack.com/api/conversations.history?channel=C123&limit=200&inclusive=true&latest=113.000&cursor=cursor-1',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
        3,
        'https://slack.com/api/conversations.replies?channel=C123&ts=111.000&oldest=110.000&latest=113.000&inclusive=true',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(messages).toEqual([
        expect.objectContaining({
          user: 'U123',
          username: 'Alice',
          text: 'earlier top-level',
          ts: '110.000',
        }),
        expect.objectContaining({
          user: 'U123',
          username: 'Alice',
          text: 'root',
          ts: '111.000',
          thread_ts: '111.000',
        }),
        expect.objectContaining({
          user: 'U234',
          username: 'Bob',
          text: 'reply',
          ts: '112.000',
          thread_ts: '111.000',
        }),
        expect.objectContaining({
          user: 'U345',
          username: 'Carol',
          text: 'later top-level',
          ts: '113.000',
        }),
      ]);
    });

    it('keeps in-range replies when the thread root predates oldest', async () => {
      const getUsersInfoSpy = vi
        .spyOn(
          SlackNotifier.prototype as unknown as {
            getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
          },
          'getUsersInfo',
        )
        .mockResolvedValue(
          new Map([
            ['U123', 'Alice'],
            ['U234', 'Bob'],
          ]),
        );

      getGlobalWithFetch().fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                user: 'U234',
                text: 'latest top-level',
                ts: '113.000',
                type: 'message',
              },
            ],
            response_metadata: {
              next_cursor: 'cursor-1',
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                user: 'U123',
                text: 'old root',
                ts: '100.000',
                thread_ts: '100.000',
                reply_count: 1,
                latest_reply: '112.000',
                type: 'message',
              },
            ],
            response_metadata: {},
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                user: 'U123',
                text: 'old root',
                ts: '100.000',
                thread_ts: '100.000',
                type: 'message',
              },
              {
                user: 'U234',
                text: 'fresh reply',
                ts: '112.000',
                thread_ts: '100.000',
                type: 'message',
              },
            ],
          }),
        });

      const messages = await notifier.fetchChannelMessages({
        channel: 'C123',
        oldest: '110.000',
        latest: '113.000',
      });

      expect(getUsersInfoSpy).toHaveBeenCalled();
      expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
        1,
        'https://slack.com/api/conversations.history?channel=C123&limit=200&inclusive=true&latest=113.000',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
        2,
        'https://slack.com/api/conversations.history?channel=C123&limit=200&inclusive=true&latest=113.000&cursor=cursor-1',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
        3,
        'https://slack.com/api/conversations.replies?channel=C123&ts=100.000&oldest=110.000&latest=113.000&inclusive=true',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(messages).toEqual([
        expect.objectContaining({
          user: 'U234',
          username: 'Bob',
          text: 'fresh reply',
          ts: '112.000',
          thread_ts: '100.000',
        }),
        expect.objectContaining({
          user: 'U234',
          username: 'Bob',
          text: 'latest top-level',
          ts: '113.000',
        }),
      ]);
    });

    it('skips thread expansion for roots whose latest reply predates oldest', async () => {
      const getUsersInfoSpy = vi
        .spyOn(
          SlackNotifier.prototype as unknown as {
            getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
          },
          'getUsersInfo',
        )
        .mockResolvedValue(
          new Map([
            ['U123', 'Alice'],
            ['U234', 'Bob'],
            ['U345', 'Carol'],
          ]),
        );

      getGlobalWithFetch().fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                user: 'U123',
                text: 'old root',
                ts: '100.000',
                thread_ts: '100.000',
                reply_count: 2,
                latest_reply: '109.000',
                type: 'message',
              },
              {
                user: 'U234',
                text: 'active root',
                ts: '111.000',
                thread_ts: '111.000',
                reply_count: 1,
                latest_reply: '112.000',
                type: 'message',
              },
              {
                user: 'U345',
                text: 'latest top-level',
                ts: '113.000',
                type: 'message',
              },
            ],
            response_metadata: {},
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                user: 'U234',
                text: 'active root',
                ts: '111.000',
                thread_ts: '111.000',
                type: 'message',
              },
              {
                user: 'U123',
                text: 'fresh reply',
                ts: '112.000',
                thread_ts: '111.000',
                type: 'message',
              },
            ],
          }),
        });

      const messages = await notifier.fetchChannelMessages({
        channel: 'C123',
        oldest: '110.000',
        latest: '113.000',
      });

      expect(getUsersInfoSpy).toHaveBeenCalled();
      expect(getGlobalWithFetch().fetch).toHaveBeenCalledTimes(2);
      expect(getGlobalWithFetch().fetch).toHaveBeenNthCalledWith(
        2,
        'https://slack.com/api/conversations.replies?channel=C123&ts=111.000&oldest=110.000&latest=113.000&inclusive=true',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(messages).toEqual([
        expect.objectContaining({
          user: 'U234',
          username: 'Bob',
          text: 'active root',
          ts: '111.000',
          thread_ts: '111.000',
        }),
        expect.objectContaining({
          user: 'U123',
          username: 'Alice',
          text: 'fresh reply',
          ts: '112.000',
          thread_ts: '111.000',
        }),
        expect.objectContaining({
          user: 'U345',
          username: 'Carol',
          text: 'latest top-level',
          ts: '113.000',
        }),
      ]);
    });

    it('throws when oldest-bounded lookups exceed the safe history page limit', async () => {
      let requestCount = 0;

      getGlobalWithFetch().fetch = vi.fn().mockImplementation(async () => {
        requestCount += 1;

        return {
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                user: 'U123',
                text: `page ${requestCount}`,
                ts: `${1000 - requestCount}.000`,
                type: 'message',
              },
            ],
            response_metadata: {
              next_cursor:
                requestCount < 25 ? `cursor-${requestCount}` : 'cursor-25',
            },
          }),
        };
      });

      await expect(
        notifier.fetchChannelMessages({
          channel: 'C123',
          oldest: '110.000',
          latest: '113.000',
        }),
      ).rejects.toThrow(
        'Slack oldest-bounded channel history lookup exceeded the safe page limit of 25; narrow the requested time range or fetch a specific thread instead',
      );
      expect(getGlobalWithFetch().fetch).toHaveBeenCalledTimes(25);
    });

    it('throws when Slack conversations.history fails', async () => {
      getGlobalWithFetch().fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Error',
      });

      await expect(
        notifier.fetchChannelMessages({
          channel: 'C123',
        }),
      ).rejects.toThrow(
        'Slack conversations.history failed: 500 Internal Error',
      );
    });
  });

  describe('replaceMentionsWithNames', () => {
    it('returns original text when there are no mentions', async () => {
      const getUsersInfoSpy = vi.spyOn(
        SlackNotifier.prototype as unknown as {
          getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
        },
        'getUsersInfo',
      );

      const input = 'Hello world';
      const output = await notifier.replaceMentionsWithNames(input);

      expect(output).toBe(input);
      expect(getUsersInfoSpy).not.toHaveBeenCalled();
    });

    it('replaces user ID mentions with display names, de-duplicating user IDs', async () => {
      const getUsersInfoSpy = vi
        .spyOn(
          SlackNotifier.prototype as unknown as {
            getUsersInfo(userIds: string[]): Promise<Map<string, string>>;
          },
          'getUsersInfo',
        )
        .mockResolvedValue(
          new Map([
            ['U123', 'Alice'],
            ['U456', 'Bob'],
          ]),
        );

      const input = 'Hi <@U123> and <@U123> plus <@U456>.';
      const output = await notifier.replaceMentionsWithNames(input);

      expect(getUsersInfoSpy).toHaveBeenCalledTimes(1);
      expect(getUsersInfoSpy).toHaveBeenCalledWith(['U123', 'U456']);
      expect(output).toBe('Hi @Alice and @Alice plus @Bob.');
    });
  });

  describe('normalizeIncomingText', () => {
    it('replaces mentions and converts Slack links to markdown', async () => {
      vi.spyOn(notifier, 'replaceMentionsWithNames').mockResolvedValue(
        'Hi @Alice <https://example.com/path|Example>',
      );

      const output = await notifier.normalizeIncomingText(
        'Hi <@U123> <https://example.com/path|Example>',
      );

      expect(output).toBe('Hi @Alice [Example](https://example.com/path)');
    });
  });

  describe('unfurlTaskUrl', () => {
    it('delegates to WebClient.chat.unfurl with metadata when provided', async () => {
      const params = {
        channel: 'C123',
        messageTs: '111.000',
        unfurls: {
          'https://example.com': {
            blocks: [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: 'hello' },
              },
            ],
          } satisfies WorkObjectUnfurl,
        },
        metadata: {
          entities: [],
        } satisfies WorkObjectMetadata,
      };

      await notifier.unfurlTaskUrl(params);

      expect(chatUnfurlMock).toHaveBeenCalledTimes(1);
      expect(chatUnfurlMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: '111.000',
          unfurls: params.unfurls,
          metadata: params.metadata,
        }),
      );
      expect(WebClientMock).toHaveBeenCalledWith(token, {
        slackApiUrl: 'https://slack.com/api/',
        timeout: Env.SLACK_API_TIMEOUT_MS,
      });
    });

    it('delegates to WebClient.chat.unfurl without metadata when not provided', async () => {
      chatUnfurlMock.mockClear();

      await notifier.unfurlTaskUrl({
        channel: 'C123',
        messageTs: '111.000',
        unfurls: {},
      });

      expect(chatUnfurlMock).toHaveBeenCalledTimes(1);
      const args = chatUnfurlMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(args.channel).toBe('C123');
      expect(args.ts).toBe('111.000');
      expect(args.unfurls).toEqual({});
      expect('metadata' in args).toBe(false);
    });
  });
});
