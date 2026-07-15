import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const upsertEnvironment = vi.fn();
  const saveSettings = vi.fn();
  const tx = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: async () => [{ setupNewState: {} }] }),
      }),
    })),
    insert: vi.fn(() => ({
      values: () => ({ onConflictDoUpdate: saveSettings }),
    })),
  };
  return { upsertEnvironment, saveSettings, tx };
});

vi.mock('@roomote/db/server', () => ({
  db: {
    transaction: (callback: (tx: typeof mocks.tx) => unknown) =>
      callback(mocks.tx),
  },
  deploymentSettings: {
    id: 'deployment_settings.id',
    setupNewState: 'deployment_settings.setup_new_state',
  },
  eq: vi.fn(),
  invalidateTeamsBotRuntimeCredentialsCache: vi.fn(),
}));

vi.mock('@/lib/server/env', () => ({
  Env: { R_APP_URL: 'https://roomote.example.com' },
}));

vi.mock('../environment-variables', () => ({
  upsertDeploymentEnvironmentVariables: mocks.upsertEnvironment,
}));

import {
  enrollCustomerHostedRoomoteCommand,
  parseRoomoteCloudEnrollmentLink,
} from './index';

const connectionToken = `rce_${'a'.repeat(43)}`;
const connectionLink = `https://cloud.example.com/#enrollment=${connectionToken}`;
const prefixedConnectionLink = `https://cloud.example.com/control-plane/#enrollment=${connectionToken}`;

describe('Roomote Cloud customer-hosted enrollment', () => {
  beforeEach(() => {
    vi.stubEnv('ROOMOTE_CLOUD_ENABLED', 'true');
    mocks.upsertEnvironment.mockClear();
    mocks.saveSettings.mockClear();
  });

  afterEach(() => vi.unstubAllEnvs());

  it('parses only one-time links on a Cloud HTTPS origin', () => {
    expect(parseRoomoteCloudEnrollmentLink(connectionLink)).toEqual({
      cloudBaseUrl: 'https://cloud.example.com',
      connectionToken,
    });
    expect(parseRoomoteCloudEnrollmentLink(prefixedConnectionLink)).toEqual({
      cloudBaseUrl: 'https://cloud.example.com/control-plane',
      connectionToken,
    });
    expect(() =>
      parseRoomoteCloudEnrollmentLink(
        'https://cloud.example.com/#enrollment=not-a-token',
      ),
    ).toThrow('invalid or expired');
  });

  it('rejects loopback connection links in production even over HTTPS', () => {
    vi.stubEnv('NODE_ENV', 'production');

    for (const baseUrl of [
      'https://localhost',
      'https://localhost.',
      'https://tenant.localhost',
      'https://127.0.0.1:4443',
      'https://[::1]:4443',
    ]) {
      expect(() =>
        parseRoomoteCloudEnrollmentLink(
          `${baseUrl}/#enrollment=${connectionToken}`,
        ),
      ).toThrow('valid Roomote Cloud connection link');
    }
  });

  it('claims the link and persists only Cloud-owned deployment settings', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          deploymentId: '00000000-0000-4000-8000-000000000001',
          workspaceId: '00000000-0000-4000-8000-000000000002',
          deploymentSlug: 'existing-roomote',
          endpointUrl: 'https://roomote.example.com',
          manifest: { hosting: { mode: 'customer_hosted' } },
          environment: {
            ROOMOTE_CLOUD_ENABLED: 'true',
            ROOMOTE_CLOUD_URL: 'https://cloud.example.com/control-plane',
            ROOMOTE_CLOUD_DEPLOYMENT_TOKEN: `rcd_${'b'.repeat(43)}`,
            ROOMOTE_CLOUD_DEPLOYMENT_ID: '00000000-0000-4000-8000-000000000001',
            ROOMOTE_CLOUD_INTEGRATION_SECRET: 'c'.repeat(43),
            ROOMOTE_CLOUD_SHARED_SLACK_ENABLED: 'true',
            ROOMOTE_CLOUD_SHARED_TEAMS_ENABLED: 'true',
            R_TEAMS_BOT_APP_ID: 'teams-app-id',
            R_TEAMS_BOT_APP_PASSWORD: `rcd_${'b'.repeat(43)}`,
            R_TEAMS_BOT_TOKEN_ENDPOINT:
              'https://cloud.example.com/control-plane/runtime/v1/integrations/teams/token',
            R_TEAMS_BOT_NAME: 'Roomote',
            R_TEAMS_BOT_OAUTH_SCOPE: 'https://api.botframework.com/.default',
            DEFAULT_COMPUTE_PROVIDER: 'roomote-cloud',
            EXCLUDED_COMPUTE_PROVIDERS: 'docker,modal',
            UNEXPECTED_SECRET: 'must-not-be-written',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await enrollCustomerHostedRoomoteCommand({
      connectionLink: prefixedConnectionLink,
      actorUserId: null,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledWith(
      'https://cloud.example.com/control-plane/enrollment/v1/claim',
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        body: JSON.stringify({
          connectionToken,
          endpointUrl: 'https://roomote.example.com',
        }),
      }),
    );
    const persistedNames =
      mocks.upsertEnvironment.mock.calls[0]?.[1].values.map(
        (value: { name: string }) => value.name,
      );
    expect(persistedNames).toContain('ROOMOTE_CLOUD_DEPLOYMENT_TOKEN');
    expect(persistedNames).not.toContain('ROOMOTE_CLOUD_ENABLED');
    expect(persistedNames).not.toContain('DEFAULT_COMPUTE_PROVIDER');
    expect(persistedNames).not.toContain('UNEXPECTED_SECRET');
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      target: 'deployment_settings.id',
      set: expect.objectContaining({
        setupNewState: expect.objectContaining({
          computeProvider: 'roomote-cloud',
        }),
        runtimeComputeConfig: {
          defaultProvider: 'roomote-cloud',
          excludedProviders: ['modal', 'docker', 'daytona', 'e2b', 'blaxel'],
        },
      }),
    });
  });

  it('stays unavailable unless the deployment explicitly enables Cloud', async () => {
    vi.stubEnv('ROOMOTE_CLOUD_ENABLED', 'false');
    const fetchFn = vi.fn<typeof fetch>();

    await expect(
      enrollCustomerHostedRoomoteCommand({
        connectionLink,
        actorUserId: null,
        fetchFn,
      }),
    ).rejects.toThrow('enrollment is not enabled');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
