import { LogLevel, type ConversationsInfoResponse } from '@slack/web-api';

import { createSlackWebClient } from './web-client';

const CHANNEL_NAME = 'roomote-managers';

type Channel = NonNullable<ConversationsInfoResponse['channel']>;

function isSafeChannel(channel: Channel | undefined): channel is Channel & {
  id: string;
} {
  return (
    typeof channel?.id === 'string' &&
    channel.id.length > 0 &&
    channel.name === CHANNEL_NAME &&
    channel.is_private === false &&
    channel.is_archived === false &&
    channel.is_shared === false &&
    channel.is_ext_shared === false &&
    channel.is_org_shared === false &&
    channel.is_pending_ext_shared === false &&
    (channel.pending_shared === undefined ||
      channel.pending_shared.length === 0) &&
    (channel.pending_connected_team_ids === undefined ||
      channel.pending_connected_team_ids.length === 0)
  );
}

/** Best effort using the installation's bot token; never falls back to private channels. */
export async function ensureSlackManagerChannel(
  botAccessToken: string,
): Promise<string | null> {
  try {
    if (!botAccessToken.trim()) return null;

    const client = createSlackWebClient(botAccessToken, {
      timeout: 5_000,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      suppressTimeoutLog: true,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        setLevel() {},
        getLevel: () => LogLevel.ERROR,
        setName() {},
      },
    });
    const deadline = Date.now() + 15_000;
    const request = async <T>(call: () => Promise<T>): Promise<T> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('deadline');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          call(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('deadline')), remaining);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const discover = async (): Promise<Channel | undefined> => {
      let cursor: string | undefined;
      let candidate: Channel | undefined;
      const cursors = new Set<string>();
      for (let page = 0; page < 10; page++) {
        const result = await request(() =>
          client.conversations.list({
            types: 'public_channel',
            exclude_archived: false,
            limit: 200,
            cursor,
          }),
        );
        if (!result.ok || !result.channels) throw new Error('discovery failed');
        for (const channel of result.channels) {
          if (channel.name !== CHANNEL_NAME) continue;
          if (!isSafeChannel(channel)) throw new Error('unsafe channel');
          if (candidate && candidate.id !== channel.id) {
            throw new Error('ambiguous channel');
          }
          candidate = channel;
        }
        cursor = result.response_metadata?.next_cursor?.trim();
        if (!cursor) return candidate;
        if (cursors.has(cursor)) throw new Error('repeated cursor');
        cursors.add(cursor);
      }
      throw new Error('truncated discovery');
    };

    let channel = await discover();
    if (!channel) {
      try {
        const created = await request(() =>
          client.conversations.create({
            name: CHANNEL_NAME,
            is_private: false,
          }),
        );
        if (!created.ok) throw new Error('create failed');
        channel = created.channel;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('data' in error) ||
          (error.data as { error?: string } | undefined)?.error !== 'name_taken'
        ) {
          throw error;
        }
        channel = await discover();
      }
    }
    if (!isSafeChannel(channel)) return null;
    const channelId = channel.id;
    const info = await request(() =>
      client.conversations.info({ channel: channelId }),
    );
    if (
      !info.ok ||
      !isSafeChannel(info.channel) ||
      info.channel.id !== channelId
    ) {
      return null;
    }
    if (info.channel.is_member !== true) {
      if (info.channel.is_member !== false) return null;
      const joined = await request(() =>
        client.conversations.join({ channel: channelId }),
      );
      if (!joined.ok) return null;
    }
    const final = await request(() =>
      client.conversations.info({ channel: channelId }),
    );
    return final.ok &&
      isSafeChannel(final.channel) &&
      final.channel.id === channelId &&
      final.channel.is_member === true
      ? channelId
      : null;
  } catch {
    console.warn('[Slack] Could not ensure public manager channel');
    return null;
  }
}
