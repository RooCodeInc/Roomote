import { buildSlackThreadPermalink } from '../slack';

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
