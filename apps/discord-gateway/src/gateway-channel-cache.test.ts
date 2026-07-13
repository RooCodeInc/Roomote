import { DiscordGatewayChannelCache } from './gateway-channel-cache';

describe('DiscordGatewayChannelCache', () => {
  it('hydrates guild channels and threads from Gateway dispatches', () => {
    const cache = new DiscordGatewayChannelCache();
    cache.ingest({
      op: 0,
      s: 1,
      t: 'GUILD_CREATE',
      d: {
        id: 'guild-1',
        channels: [{ id: 'channel-1', type: 0, name: 'general' }],
        threads: [
          {
            id: 'thread-1',
            type: 11,
            parent_id: 'channel-1',
            owner_id: 'bot-1',
            name: 'task',
          },
        ],
      },
    } as never);

    expect(cache.get('channel-1')).toEqual({
      id: 'channel-1',
      type: 0,
      guildId: 'guild-1',
      name: 'general',
      isThread: false,
    });
    expect(cache.get('thread-1')).toEqual({
      id: 'thread-1',
      type: 11,
      guildId: 'guild-1',
      parentId: 'channel-1',
      ownerId: 'bot-1',
      name: 'task',
      isThread: true,
    });
  });

  it('lazily fetches channel metadata after a cross-process resume', async () => {
    const cache = new DiscordGatewayChannelCache();
    const rest = {
      get: vi.fn(async () => ({
        id: 'thread-1',
        type: 11,
        guild_id: 'guild-1',
        parent_id: 'channel-1',
        owner_id: 'bot-1',
        name: 'task',
      })),
    };

    await expect(cache.fetch('thread-1', rest as never)).resolves.toEqual({
      id: 'thread-1',
      type: 11,
      guildId: 'guild-1',
      parentId: 'channel-1',
      ownerId: 'bot-1',
      name: 'task',
      isThread: true,
    });
    await cache.fetch('thread-1', rest as never);
    expect(rest.get).toHaveBeenCalledOnce();
  });
});
