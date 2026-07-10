import {
  buildSlackAppManifest,
  buildSlackManifestPrefillUrl,
  SLACK_MANIFEST_BACKGROUND_COLOR,
  SLACK_MANIFEST_BOT_EVENTS,
  SLACK_MANIFEST_BOT_SCOPES,
  SLACK_MANIFEST_DESCRIPTION,
} from './slack-app-manifest';

describe('Slack app manifest builder', () => {
  it('includes Roomote app display metadata', () => {
    const manifest = buildSlackAppManifest({
      publicOrigin: 'https://roomote.example.com',
    });

    expect(manifest.display_information).toEqual({
      name: 'Roomote',
      description: SLACK_MANIFEST_DESCRIPTION,
      background_color: SLACK_MANIFEST_BACKGROUND_COLOR,
    });
  });

  it('marks the bot user as always online', () => {
    const manifest = buildSlackAppManifest({
      publicOrigin: 'https://roomote.example.com',
    });

    expect(manifest.features.bot_user).toEqual({
      display_name: 'Roomote',
      always_online: true,
    });
  });

  it('includes Slack OAuth callback URLs from the deployment origin', () => {
    const manifest = buildSlackAppManifest({
      publicOrigin: 'https://roomote.example.com/',
    });

    expect(manifest.oauth_config.redirect_urls).toEqual([
      'https://roomote.example.com/api/auth/oauth2/callback/slack',
      'https://roomote.example.com/api/slack/callback',
    ]);
  });

  it('includes Slack webhook and interactivity URLs', () => {
    const manifest = buildSlackAppManifest({
      publicOrigin: 'https://roomote.example.com',
    });

    expect(manifest.settings.event_subscriptions.request_url).toBe(
      'https://roomote.example.com/api/webhooks/slack',
    );
    expect(manifest.settings.interactivity).toMatchObject({
      is_enabled: true,
      request_url: 'https://roomote.example.com/api/webhooks/slack',
    });
  });

  it('includes expected bot scopes and event subscriptions', () => {
    const manifest = buildSlackAppManifest({
      publicOrigin: 'https://roomote.example.com',
    });

    expect(manifest.oauth_config.scopes.bot).toEqual([
      ...SLACK_MANIFEST_BOT_SCOPES,
    ]);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual([
      ...SLACK_MANIFEST_BOT_EVENTS,
    ]);
    expect(manifest.oauth_config.scopes.bot).toEqual(
      expect.arrayContaining([
        'app_mentions:read',
        'chat:write',
        'reactions:write',
        'users:read',
      ]),
    );
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining([
        'app_mention',
        'function_executed',
        'message.im',
        'reaction_added',
      ]),
    );
  });

  it('builds Slack manifest-prefill URLs with the manifest encoded', () => {
    const url = new URL(
      buildSlackManifestPrefillUrl({
        publicOrigin: 'https://roomote.example.com',
      }),
    );

    expect(url.origin + url.pathname).toBe('https://api.slack.com/apps');
    expect(url.searchParams.get('new_app')).toBe('1');
    expect(
      JSON.parse(url.searchParams.get('manifest_json') ?? '{}'),
    ).toMatchObject({
      oauth_config: {
        redirect_urls: [
          'https://roomote.example.com/api/auth/oauth2/callback/slack',
          'https://roomote.example.com/api/slack/callback',
        ],
      },
    });
  });
});
