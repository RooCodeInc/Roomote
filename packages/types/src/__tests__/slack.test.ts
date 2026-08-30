import {
  buildSlackThreadPermalink,
  parseSlackChannelPermalink,
  parseSlackMessagePermalink,
} from '../slack';

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
