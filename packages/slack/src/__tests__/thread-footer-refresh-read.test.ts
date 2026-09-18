import { afterEach, describe, expect, it, vi } from 'vitest';
const fetch = vi.hoisted(() => vi.fn());
vi.mock('../slack-api-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../slack-api-fetch')>()),
  slackFetch: fetch,
}));
import { SlackNotifier } from '../slack-notifier';

describe('refresh carrier lookup distinguishes missing from unavailable', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fetch.mockReset();
  });
  const input = {
    channel: 'C',
    threadTs: 'T',
    messageTs: 'M',
    throwOnUnavailable: true,
  };
  it.each(['thread_not_found', 'message_not_found', 'channel_not_found'])(
    'returns a missing result for %s',
    async (error) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      fetch.mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error })),
      );
      expect(
        await new SlackNotifier('test-token').getMessageBlocks(input),
      ).toBeNull();
    },
  );
  it('returns missing only when a successful response lacks the requested message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, messages: [{ ts: 'T', blocks: [] }] }),
      ),
    );
    expect(
      await new SlackNotifier('test-token').getMessageBlocks(input),
    ).toBeNull();
  });
  it.each([429, 500])(
    'throws HTTP %s so refresh retries rather than forgetting a live carrier',
    async (status) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      fetch.mockResolvedValue(new Response('', { status }));
      await expect(
        new SlackNotifier('test-token').getMessageBlocks(input),
      ).rejects.toThrow('unavailable');
    },
  );
  it('throws transient Slack API errors rather than returning a missing result', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'ratelimited' })),
    );
    await expect(
      new SlackNotifier('test-token').getMessageBlocks(input),
    ).rejects.toThrow('ratelimited');
  });
});
