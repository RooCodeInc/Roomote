import { buildDiscordMessagePermalink } from '../discord';

describe('buildDiscordMessagePermalink', () => {
  it('builds server and DM message links', () => {
    expect(
      buildDiscordMessagePermalink({
        guildId: '123',
        channelId: '456',
        messageId: '789',
      }),
    ).toBe('https://discord.com/channels/123/456/789');
    expect(
      buildDiscordMessagePermalink({ channelId: '456', messageId: '789' }),
    ).toBe('https://discord.com/channels/@me/456/789');
  });

  it('requires a channel id', () => {
    expect(buildDiscordMessagePermalink({ guildId: '123' })).toBeNull();
  });
});
