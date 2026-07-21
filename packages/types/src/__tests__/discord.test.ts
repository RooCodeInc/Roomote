import {
  buildDiscordMessagePermalink,
  parseDiscordMessagePermalink,
} from '../discord';

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

describe('parseDiscordMessagePermalink', () => {
  it('parses server message links', () => {
    expect(
      parseDiscordMessagePermalink('https://discord.com/channels/123/456/789'),
    ).toEqual({
      guildId: '123',
      channelId: '456',
      messageId: '789',
    });
  });

  it('parses DM and host variants without a message id', () => {
    expect(
      parseDiscordMessagePermalink(
        'https://canary.discord.com/channels/@me/456',
      ),
    ).toEqual({
      guildId: null,
      channelId: '456',
      messageId: null,
    });
    expect(
      parseDiscordMessagePermalink(
        'https://discordapp.com/channels/1/2/3?foo=1#fragment',
      ),
    ).toEqual({
      guildId: '1',
      channelId: '2',
      messageId: '3',
    });
  });

  it('rejects non-discord urls', () => {
    expect(
      parseDiscordMessagePermalink('https://example.com/channels/1/2/3'),
    ).toBeNull();
  });
});
