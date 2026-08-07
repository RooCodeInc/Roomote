import {
  SLACK_APP_INSTALL_CALLBACK_PATH,
  SLACK_SIGN_IN_CALLBACK_PATH,
} from './slack-callback-paths';

export const SLACK_MANIFEST_BOT_SCOPES = [
  'app_mentions:read',
  'channels:read',
  'channels:history',
  'chat:write',
  'files:read',
  'groups:read',
  'groups:history',
  'im:read',
  'im:history',
  'im:write',
  'links:read',
  'links:write',
  'mpim:read',
  'mpim:history',
  'reactions:read',
  'reactions:write',
  'team:read',
  'users:read',
] as const;

export const SLACK_SUPPORT_CHANNEL_BOT_SCOPES = [
  'groups:write',
  'conversations.connect:write',
] as const;

export function getSlackManifestBotScopes(supportChannelEnabled = false) {
  return supportChannelEnabled
    ? [...SLACK_MANIFEST_BOT_SCOPES, ...SLACK_SUPPORT_CHANNEL_BOT_SCOPES]
    : [...SLACK_MANIFEST_BOT_SCOPES];
}

export const SLACK_MANIFEST_BOT_EVENTS = [
  'app_mention',
  'entity_details_requested',
  'function_executed',
  'link_shared',
  'member_joined_channel',
  'message.channels',
  'message.groups',
  'message.im',
  'message.mpim',
  'reaction_added',
] as const;

export const SLACK_MANIFEST_DESCRIPTION = 'Cloud coding agents for all';
export const SLACK_MANIFEST_BACKGROUND_COLOR = '#000000';

type SlackAppManifestInput = {
  publicOrigin: string;
  appName?: string;
  supportChannelEnabled?: boolean;
};

export function buildSlackAppManifest({
  publicOrigin,
  appName = 'Roomote',
  supportChannelEnabled = false,
}: SlackAppManifestInput) {
  const origin = publicOrigin.replace(/\/+$/, '');
  const webhookUrl = `${origin}/api/webhooks/slack`;

  return {
    display_information: {
      name: appName,
      description: SLACK_MANIFEST_DESCRIPTION,
      background_color: SLACK_MANIFEST_BACKGROUND_COLOR,
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: appName,
        always_online: true,
      },
    },
    oauth_config: {
      redirect_urls: [
        `${origin}${SLACK_SIGN_IN_CALLBACK_PATH}`,
        `${origin}${SLACK_APP_INSTALL_CALLBACK_PATH}`,
      ],
      scopes: {
        bot: getSlackManifestBotScopes(supportChannelEnabled),
      },
      pkce_enabled: false,
    },
    settings: {
      event_subscriptions: {
        request_url: webhookUrl,
        bot_events: [...SLACK_MANIFEST_BOT_EVENTS],
      },
      interactivity: {
        is_enabled: true,
        request_url: webhookUrl,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

export function buildSlackManifestPrefillUrl(input: SlackAppManifestInput) {
  const params = new URLSearchParams({
    new_app: '1',
    manifest_json: JSON.stringify(buildSlackAppManifest(input)),
  });

  return `https://api.slack.com/apps?${params.toString()}`;
}
