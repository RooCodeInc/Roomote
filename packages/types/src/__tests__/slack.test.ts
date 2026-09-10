import {
  buildSlackChannelUrl,
  buildSlackThreadPermalink,
  buildSlackUserProfileUrl,
  extractSlackChannelMentionIds,
  extractSlackUserMentionIds,
  parseSlackChannelPermalink,
  parseSlackMessagePermalink,
  parseSlackMessageTokens,
} from '../slack';

describe('parseSlackMessageTokens', () => {
  it('returns plain text untouched', () => {
    expect(parseSlackMessageTokens('just words')).toEqual([
      { type: 'text', text: 'just words' },
    ]);
  });

  it('splits user, channel, usergroup, and broadcast references', () => {
    expect(
      parseSlackMessageTokens(
        '<@U0BJNE7FC12> ping <@W123|jane> in <#C456|general> <!subteam^S789|@eng> <!here>',
      ),
    ).toEqual([
      { type: 'user', userId: 'U0BJNE7FC12', label: null },
      { type: 'text', text: ' ping ' },
      { type: 'user', userId: 'W123', label: 'jane' },
      { type: 'text', text: ' in ' },
      { type: 'channel', channelId: 'C456', label: 'general' },
      { type: 'text', text: ' ' },
      { type: 'usergroup', usergroupId: 'S789', label: 'eng' },
      { type: 'text', text: ' ' },
      { type: 'broadcast', name: 'here' },
    ]);
  });

  it('parses malformed reference fragments in linear time', () => {
    const malformed = '<@U0|'.repeat(20_000);
    const started = performance.now();
    const tokens = parseSlackMessageTokens(malformed);
    expect(performance.now() - started).toBeLessThan(200);
    expect(tokens).toEqual([{ type: 'text', text: malformed }]);

    expect(parseSlackMessageTokens('<@U1|<@U2|jane> tail')).toEqual([
      { type: 'text', text: '<@U1|' },
      { type: 'user', userId: 'U2', label: 'jane' },
      { type: 'text', text: ' tail' },
    ]);
  });

  it('parses Slack link references and drops labels that repeat the url', () => {
    expect(
      parseSlackMessageTokens(
        'I like <https://roomote.dev> and <https://example.com/path|Example> <mailto:a@b.co|a@b.co>',
      ),
    ).toEqual([
      { type: 'text', text: 'I like ' },
      { type: 'link', url: 'https://roomote.dev', label: null },
      { type: 'text', text: ' and ' },
      { type: 'link', url: 'https://example.com/path', label: 'Example' },
      { type: 'text', text: ' ' },
      { type: 'link', url: 'mailto:a@b.co', label: null },
    ]);
  });

  it('leaves unrelated angle-bracket text alone', () => {
    expect(parseSlackMessageTokens('use <b>bold</b> or <T> generics')).toEqual([
      { type: 'text', text: 'use <b>bold</b> or <T> generics' },
    ]);
  });
});

describe('extractSlackUserMentionIds', () => {
  it('dedupes user ids in first-seen order', () => {
    expect(
      extractSlackUserMentionIds('<@U2> then <@U1> and <@U2> again <#C1>'),
    ).toEqual(['U2', 'U1']);
  });
});

describe('extractSlackChannelMentionIds', () => {
  it('dedupes channel ids in first-seen order', () => {
    expect(
      extractSlackChannelMentionIds('<#C2|ops> then <#C1> and <#C2> <@U1>'),
    ).toEqual(['C2', 'C1']);
  });
});

describe('buildSlackChannelUrl', () => {
  it('prefers the workspace archive url when the domain is known', () => {
    expect(
      buildSlackChannelUrl({
        slackChannelId: 'C123',
        slackTeamId: 'T123',
        slackWorkspaceDomain: 'acme-team',
      }),
    ).toBe('https://acme-team.slack.com/archives/C123');
  });

  it('falls back to the app redirect with only a team id', () => {
    expect(
      buildSlackChannelUrl({ slackChannelId: 'C123', slackTeamId: 'T123' }),
    ).toBe('https://slack.com/app_redirect?channel=C123&team=T123');
  });

  it('returns null without a team id or domain', () => {
    expect(buildSlackChannelUrl({ slackChannelId: 'C123' })).toBeNull();
  });
});

describe('buildSlackUserProfileUrl', () => {
  it('prefers the workspace web profile when the domain is known', () => {
    expect(
      buildSlackUserProfileUrl({
        slackUserId: 'U123',
        slackTeamId: 'T123',
        slackWorkspaceDomain: 'acme-team',
      }),
    ).toBe('https://acme-team.slack.com/team/U123');
  });

  it('falls back to the slack:// deep link with only a team id', () => {
    expect(
      buildSlackUserProfileUrl({ slackUserId: 'U123', slackTeamId: 'T123' }),
    ).toBe('slack://user?team=T123&id=U123');
  });

  it('returns null without a team id or domain', () => {
    expect(buildSlackUserProfileUrl({ slackUserId: 'U123' })).toBeNull();
  });
});

describe('buildSlackThreadPermalink', () => {
  it('builds an app.slack.com permalink when no workspace domain is available', () => {
    expect(
      buildSlackThreadPermalink({
        slackChannelId: 'C123456',
        threadTs: '1776819983.463289',
      }),
    ).toBe(
      'https://app.slack.com/archives/C123456/p1776819983463289?thread_ts=1776819983.463289&cid=C123456',
    );
  });

  it('uses the workspace subdomain when available', () => {
    expect(
      buildSlackThreadPermalink({
        slackWorkspaceDomain: ' acme-team ',
        slackChannelId: 'C123456',
        threadTs: '1776819983.463289',
      }),
    ).toBe(
      'https://acme-team.slack.com/archives/C123456/p1776819983463289?thread_ts=1776819983.463289&cid=C123456',
    );
  });

  it('uses Slack app_redirect when only the team id is available', () => {
    expect(
      buildSlackThreadPermalink({
        slackTeamId: ' T123456 ',
        slackChannelId: 'C123456',
        threadTs: '1776819983.463289',
      }),
    ).toBe('https://slack.com/app_redirect?channel=C123456&team=T123456');
  });

  it('links a specific reply when both message and thread timestamps are available', () => {
    expect(
      buildSlackThreadPermalink({
        slackTeamId: 'T123456',
        slackChannelId: 'C123456',
        threadTs: '1776819983.463289',
        messageTs: '1776819999.123456',
      }),
    ).toBe(
      'https://app.slack.com/archives/C123456/p1776819999123456?thread_ts=1776819983.463289&cid=C123456',
    );
  });

  it('returns null when channel or thread metadata is missing', () => {
    expect(
      buildSlackThreadPermalink({
        slackWorkspaceDomain: 'acme-team',
        slackChannelId: null,
        threadTs: '1776819983.463289',
      }),
    ).toBeNull();
    expect(
      buildSlackThreadPermalink({
        slackWorkspaceDomain: 'acme-team',
        slackChannelId: 'C123456',
        threadTs: null,
      }),
    ).toBeNull();
  });
});

describe('parseSlackMessagePermalink', () => {
  it('parses workspace and app archive permalinks', () => {
    expect(
      parseSlackMessagePermalink(
        'https://acme.slack.com/archives/C123/p1710000000000100?thread_ts=1710000000.000000',
      ),
    ).toEqual({
      teamId: null,
      channelId: 'C123',
      messageId: '1710000000.000100',
    });

    expect(
      parseSlackMessagePermalink(
        'https://app.slack.com/archives/C456/p1710000000000200',
      ),
    ).toEqual({
      teamId: null,
      channelId: 'C456',
      messageId: '1710000000.000200',
    });
  });

  it('parses app client thread links', () => {
    expect(
      parseSlackMessagePermalink(
        'https://app.slack.com/client/T123/C456/thread/C456-1710000000.000100',
      ),
    ).toEqual({
      teamId: 'T123',
      channelId: 'C456',
      messageId: '1710000000.000100',
    });
  });

  it('rejects unrelated and malformed links', () => {
    expect(
      parseSlackMessagePermalink(
        'https://example.com/archives/C123/p1710000000000100',
      ),
    ).toBeNull();
    expect(
      parseSlackMessagePermalink('https://app.slack.com/archives/C123/nope'),
    ).toBeNull();
  });
});

describe('parseSlackChannelPermalink', () => {
  it('parses workspace archive and app client channel links', () => {
    expect(
      parseSlackChannelPermalink('https://acme.slack.com/archives/C123'),
    ).toEqual({ teamId: null, channelId: 'C123' });
    expect(
      parseSlackChannelPermalink('https://app.slack.com/client/T123/C456'),
    ).toEqual({ teamId: 'T123', channelId: 'C456' });
  });

  it('does not treat a message link as a channel-only link', () => {
    expect(
      parseSlackChannelPermalink(
        'https://acme.slack.com/archives/C123/p1710000000000100',
      ),
    ).toBeNull();
  });
});
