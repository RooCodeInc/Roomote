import {
  buildSlackAppManifest,
  buildSlackManifestPrefillUrl,
  SLACK_MANIFEST_BACKGROUND_COLOR,
  SLACK_MANIFEST_BOT_EVENTS,
  SLACK_MANIFEST_BOT_SCOPES,
  SLACK_MANIFEST_DESCRIPTION,
  SLACK_SUPPORT_CHANNEL_BOT_SCOPES,
} from './slack-app-manifest';

function relativeLuminance(hex: string): number {
  const normalized = hex.replace('#', '');
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((part) => part + part)
          .join('')
      : normalized;
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(full.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (lighter + 0.05) / (darker + 0.05);
}

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

  it('uses a background color with enough contrast for light text', () => {
    expect(
      contrastRatio(SLACK_MANIFEST_BACKGROUND_COLOR, '#FFFFFF'),
    ).toBeGreaterThanOrEqual(4.5);
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

  it('disables the App Home tab and keeps Messages writable', () => {
    const manifest = buildSlackAppManifest({
      publicOrigin: 'https://roomote.example.com',
    });

    expect(manifest.features.app_home).toEqual({
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
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

  it('adds support-channel scopes only when enabled', () => {
    const standardManifest = buildSlackAppManifest({
      publicOrigin: 'https://roomote.example.com',
    });
    const cloudManifest = buildSlackAppManifest({
      publicOrigin: 'https://roomote.example.com',
      supportChannelEnabled: true,
    });

    expect(standardManifest.oauth_config.scopes.bot).not.toEqual(
      expect.arrayContaining([...SLACK_SUPPORT_CHANNEL_BOT_SCOPES]),
    );
    expect(cloudManifest.oauth_config.scopes.bot).toEqual(
      expect.arrayContaining([...SLACK_SUPPORT_CHANNEL_BOT_SCOPES]),
    );
    expect(cloudManifest.oauth_config.scopes.bot).not.toContain(
      'channels:manage',
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
