import { buildFastAgentSessionChannelKey } from '../fast-agent-session';

describe('fast-agent session scoping', () => {
  it('keeps identical Slack channels isolated by workspace', () => {
    expect(
      buildFastAgentSessionChannelKey({
        slackTeamId: 'team-1',
        slackChannel: 'channel-1',
      }),
    ).not.toBe(
      buildFastAgentSessionChannelKey({
        slackTeamId: 'team-2',
        slackChannel: 'channel-1',
      }),
    );
  });
});
