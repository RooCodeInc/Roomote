import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveEffectiveDeploymentEnvVarsMock } = vi.hoisted(() => ({
  resolveEffectiveDeploymentEnvVarsMock: vi.fn(),
}));

vi.mock('../model-runtime-config', () => ({
  resolveEffectiveDeploymentEnvVars: resolveEffectiveDeploymentEnvVarsMock,
}));

import {
  invalidateTeamsBotRuntimeCredentialsCache,
  resolveTeamsBotRuntimeCredentials,
} from '../teams-runtime-credentials';

const ENV_VAR_NAMES = [
  'R_TEAMS_BOT_APP_ID',
  'R_TEAMS_BOT_APP_PASSWORD',
  'R_TEAMS_BOT_TENANT_ID',
  'R_TEAMS_BOT_TOKEN_ENDPOINT',
  'R_TEAMS_BOT_OAUTH_SCOPE',
] as const;

describe('resolveTeamsBotRuntimeCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateTeamsBotRuntimeCredentialsCache();
    resolveEffectiveDeploymentEnvVarsMock.mockResolvedValue({});

    for (const name of ENV_VAR_NAMES) {
      vi.stubEnv(name, '');
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the dedicated R_TEAMS_BOT_* pair from process env without touching the database', async () => {
    vi.stubEnv('R_TEAMS_BOT_APP_ID', 'bot-id');
    vi.stubEnv('R_TEAMS_BOT_APP_PASSWORD', 'bot-secret');
    vi.stubEnv('R_TEAMS_BOT_TENANT_ID', 'bot-tenant');

    await expect(resolveTeamsBotRuntimeCredentials()).resolves.toMatchObject({
      botAppId: 'bot-id',
      botAppPassword: 'bot-secret',
      botTenantId: 'bot-tenant',
      source: 'teams_bot',
    });
    expect(resolveEffectiveDeploymentEnvVarsMock).not.toHaveBeenCalled();
  });

  it('does not fall back to the Microsoft sign-in app saved from the settings UI', async () => {
    resolveEffectiveDeploymentEnvVarsMock.mockResolvedValue({
      R_MICROSOFT_CLIENT_ID: 'signin-id',
      R_MICROSOFT_CLIENT_SECRET: 'signin-secret',
      R_MICROSOFT_TENANT_ID: 'signin-tenant',
    });

    await expect(resolveTeamsBotRuntimeCredentials()).resolves.toMatchObject({
      botAppId: null,
      botAppPassword: null,
      botTenantId: null,
      source: null,
    });
  });

  it('never mixes a Teams bot id with a Microsoft sign-in secret', async () => {
    vi.stubEnv('R_TEAMS_BOT_APP_ID', 'bot-id');
    vi.stubEnv('R_MICROSOFT_CLIENT_ID', 'signin-id');
    vi.stubEnv('R_MICROSOFT_CLIENT_SECRET', 'signin-secret');

    await expect(resolveTeamsBotRuntimeCredentials()).resolves.toMatchObject({
      botAppId: null,
      botAppPassword: null,
      source: null,
    });
  });

  it('completes a partial TEAMS_BOT env pair from saved deployment env vars', async () => {
    vi.stubEnv('R_TEAMS_BOT_APP_ID', 'bot-id');
    resolveEffectiveDeploymentEnvVarsMock.mockResolvedValue({
      R_TEAMS_BOT_APP_PASSWORD: 'saved-bot-secret',
    });

    await expect(resolveTeamsBotRuntimeCredentials()).resolves.toMatchObject({
      botAppId: 'bot-id',
      botAppPassword: 'saved-bot-secret',
      source: 'teams_bot',
    });
  });

  it('returns nulls when nothing is configured', async () => {
    await expect(resolveTeamsBotRuntimeCredentials()).resolves.toMatchObject({
      botAppId: null,
      botAppPassword: null,
      source: null,
    });
  });

  it('caches database-backed lookups until invalidated', async () => {
    resolveEffectiveDeploymentEnvVarsMock.mockResolvedValue({
      R_TEAMS_BOT_APP_ID: 'bot-id',
      R_TEAMS_BOT_APP_PASSWORD: 'bot-secret',
    });

    await resolveTeamsBotRuntimeCredentials();
    await resolveTeamsBotRuntimeCredentials();
    expect(resolveEffectiveDeploymentEnvVarsMock).toHaveBeenCalledTimes(1);

    invalidateTeamsBotRuntimeCredentialsCache();
    await resolveTeamsBotRuntimeCredentials();
    expect(resolveEffectiveDeploymentEnvVarsMock).toHaveBeenCalledTimes(2);
  });
});
