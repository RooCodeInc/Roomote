import { buildFastAgentSessionChannelKey } from '../fast-agent-session';

describe('fast-agent session scoping', () => {
  it('keeps identical Slack channels isolated by workspace', () => {
    expect(
      buildFastAgentSessionChannelKey({
        surface: 'slack',
        workspaceId: 'team-1',
        channelId: 'channel-1',
      }),
    ).not.toBe(
      buildFastAgentSessionChannelKey({
        surface: 'slack',
        workspaceId: 'team-2',
        channelId: 'channel-1',
      }),
    );
  });

  it('preserves the existing Discord storage namespace for raw provider IDs', () => {
    expect(
      buildFastAgentSessionChannelKey({
        surface: 'discord',
        workspaceId: 'guild-1',
        channelId: 'channel-1',
      }),
    ).toBe('discord:guild-1:channel-1');
  });
});
