import type { UserAuthSuccess } from '@/types';

const { mockFetch, mockFindFirst } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockFindFirst: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  buildSlackApiUrl: (path: string) => `https://slack.example.test/api/${path}`,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      slackInstallations: { findFirst: mockFindFirst },
    },
  },
  desc: vi.fn((value) => value),
  eq: vi.fn(() => true),
  slackInstallations: {
    isActive: 'isActive',
    updatedAt: 'updatedAt',
  },
}));

vi.mock('@/lib/server', () => ({
  Env: {
    R_APP_URL: 'http://localhost:3000/',
    R_PUBLIC_URL: 'https://roomote.example.com/',
  },
}));

vi.stubGlobal('fetch', mockFetch);

import {
  reconcileSlackAppManifest,
  updateSlackAppManifestCommand,
} from './update-app-manifest';
import { buildSlackAppManifest } from '@/lib/slack-app-manifest';

function buildMockAuth(
  overrides: Partial<UserAuthSuccess> = {},
): UserAuthSuccess {
  return {
    success: true,
    userType: 'user',
    userId: 'slack-manifest-update-user',
    isAdmin: true,
    name: 'Slack Manifest Updater',
    primaryEmail: 'slack@example.com',
    resource: {},
    ...overrides,
  } as UserAuthSuccess;
}

function slackResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('reconcileSlackAppManifest', () => {
  it('adds Roomote requirements without removing custom manifest fields', () => {
    const required = buildSlackAppManifest({
      publicOrigin: 'https://roomote.example.com',
    });
    const current = {
      display_information: { name: 'Custom Roomote' },
      features: {
        bot_user: { display_name: 'Custom Bot', always_online: false },
        slash_commands: [{ command: '/custom' }],
      },
      oauth_config: {
        redirect_urls: ['https://custom.example.com/oauth'],
        scopes: { bot: ['commands'], user: ['identity.basic'] },
      },
      settings: {
        event_subscriptions: {
          request_url: 'https://old.example.com/slack',
          bot_events: ['workflow_step_execute'],
        },
      },
    };

    const result = reconcileSlackAppManifest({ current, required });

    expect(result.display_information).toEqual({ name: 'Custom Roomote' });
    expect(result.features).toMatchObject({
      bot_user: { display_name: 'Custom Bot', always_online: false },
      slash_commands: [{ command: '/custom' }],
      agent_view: { agent_description: 'Cloud coding agents for all' },
    });
    expect(result.oauth_config).toMatchObject({
      redirect_urls: [
        'https://custom.example.com/oauth',
        'https://roomote.example.com/api/auth/oauth2/callback/slack',
        'https://roomote.example.com/api/slack/callback',
      ],
      scopes: {
        user: ['identity.basic'],
        bot: expect.arrayContaining(['commands', 'assistant:write']),
      },
    });
    expect(result.settings).toMatchObject({
      event_subscriptions: {
        request_url: 'https://roomote.example.com/api/webhooks/slack',
        bot_events: expect.arrayContaining([
          'workflow_step_execute',
          'app_context_changed',
        ]),
      },
      interactivity: {
        is_enabled: true,
        request_url: 'https://roomote.example.com/api/webhooks/slack',
      },
    });
  });
});

describe('updateSlackAppManifestCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockResolvedValue({ appId: 'A0ROOMOTE' });
  });

  it('rejects non-admin users without calling Slack', async () => {
    const result = await updateSlackAppManifestCommand(
      buildMockAuth({ isAdmin: false }),
      { configToken: 'xoxe.xoxp-token' },
    );

    expect(result).toEqual({ success: false, error: 'Unauthorized' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('requires a connected Slack app', async () => {
    mockFindFirst.mockResolvedValue(null);

    const result = await updateSlackAppManifestCommand(buildMockAuth(), {
      configToken: 'xoxe.xoxp-token',
    });

    expect(result).toEqual({
      success: false,
      error: 'Connect a Slack workspace before updating its app manifest.',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('exports, validates, and updates the full manifest', async () => {
    mockFetch
      .mockResolvedValueOnce(
        slackResponse({
          ok: true,
          manifest: {
            display_information: { name: 'Custom Roomote' },
            features: { bot_user: { display_name: 'Custom Bot' } },
            oauth_config: { scopes: { bot: ['chat:write'] } },
            settings: {},
          },
        }),
      )
      .mockResolvedValueOnce(slackResponse({ ok: true, errors: [] }))
      .mockResolvedValueOnce(
        slackResponse({
          ok: true,
          app_id: 'A0ROOMOTE',
          permissions_updated: true,
        }),
      );

    const result = await updateSlackAppManifestCommand(buildMockAuth(), {
      configToken: '  xoxe.xoxp-token  ',
    });

    expect(result).toEqual({
      success: true,
      changed: true,
      reinstallRequired: true,
      appSettingsUrl: 'https://api.slack.com/apps/A0ROOMOTE',
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://slack.example.test/api/apps.manifest.export',
      'https://slack.example.test/api/apps.manifest.validate',
      'https://slack.example.test/api/apps.manifest.update',
    ]);

    for (const [, init] of mockFetch.mock.calls) {
      expect(init.headers.Authorization).toBe('Bearer xoxe.xoxp-token');
    }

    const validateBody = JSON.parse(mockFetch.mock.calls[1]![1].body) as {
      app_id: string;
      manifest: string;
    };
    const updateBody = JSON.parse(mockFetch.mock.calls[2]![1].body) as {
      app_id: string;
      manifest: string;
    };
    expect(validateBody).toEqual(updateBody);
    expect(validateBody.app_id).toBe('A0ROOMOTE');
    expect(JSON.parse(validateBody.manifest)).toMatchObject({
      display_information: { name: 'Custom Roomote' },
      features: {
        bot_user: { display_name: 'Custom Bot' },
        agent_view: { agent_description: 'Cloud coding agents for all' },
      },
    });
  });

  it('does not update an app whose manifest is already current', async () => {
    const manifest = buildSlackAppManifest({
      publicOrigin: 'https://roomote.example.com',
    });
    mockFetch.mockResolvedValueOnce(slackResponse({ ok: true, manifest }));

    const result = await updateSlackAppManifestCommand(buildMockAuth(), {
      configToken: 'xoxe.xoxp-token',
    });

    expect(result).toEqual({
      success: true,
      changed: false,
      reinstallRequired: false,
      appSettingsUrl: 'https://api.slack.com/apps/A0ROOMOTE',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns a useful error for an expired configuration token', async () => {
    mockFetch.mockResolvedValueOnce(
      slackResponse({ ok: false, error: 'token_expired' }),
    );

    const result = await updateSlackAppManifestCommand(buildMockAuth(), {
      configToken: 'xoxe.xoxp-expired',
    });

    expect(result).toEqual({
      success: false,
      error:
        'Slack rejected the app configuration token. Generate a fresh token at api.slack.com/apps and try again.',
    });
  });
});
