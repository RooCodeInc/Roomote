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
  'TEAMS_BOT_APP_ID',
  'TEAMS_BOT_APP_PASSWORD',
  'TEAMS_BOT_TENANT_ID',
  'TEAMS_BOT_TOKEN_ENDPOINT',
  'TEAMS_BOT_OAUTH_SCOPE',
  'ROOMOTE_AUTH_MICROSOFT_CLIENT_ID',
  'ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET',
  'ROOMOTE_AUTH_MICROSOFT_TENANT_ID',
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

  it('uses the dedicated TEAMS_BOT_* pair from process env without touching the database', async () => {
    vi.stubEnv('TEAMS_BOT_APP_ID', 'bot-id');
    vi.stubEnv('TEAMS_BOT_APP_PASSWORD', 'bot-secret');
    vi.stubEnv('TEAMS_BOT_TENANT_ID', 'bot-tenant');

    await expect(resolveTeamsBotRuntimeCredentials()).resolves.toMatchObject({
      botAppId: 'bot-id',
      botAppPassword: 'bot-secret',
      botTenantId: 'bot-tenant',
      source: 'teams_bot',
    });
    expect(resolveEffectiveDeploymentEnvVarsMock).not.toHaveBeenCalled();
  });

  it('falls back to the Microsoft sign-in app saved from the settings UI', async () => {
    resolveEffectiveDeploymentEnvVarsMock.mockResolvedValue({
      ROOMOTE_AUTH_MICROSOFT_CLIENT_ID: 'signin-id',
      ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET: 'signin-secret',
      ROOMOTE_AUTH_MICROSOFT_TENANT_ID: 'signin-tenant',
    });

    await expect(resolveTeamsBotRuntimeCredentials()).resolves.toMatchObject({
      botAppId: 'signin-id',
      botAppPassword: 'signin-secret',
      botTenantId: 'signin-tenant',
      source: 'microsoft_auth',
    });
  });

  it('never mixes a TEAMS_BOT id with a Microsoft sign-in secret', async () => {
    // Bot app id without its password: the pair is incomplete, so the
    // Microsoft trio is used as a unit instead.
    vi.stubEnv('TEAMS_BOT_APP_ID', 'bot-id');
    vi.stubEnv('ROOMOTE_AUTH_MICROSOFT_CLIENT_ID', 'signin-id');
    vi.stubEnv('ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET', 'signin-secret');

    await expect(resolveTeamsBotRuntimeCredentials()).resolves.toMatchObject({
      botAppId: 'signin-id',
      botAppPassword: 'signin-secret',
      source: 'microsoft_auth',
    });
  });

  it('completes a partial TEAMS_BOT env pair from saved deployment env vars', async () => {
    vi.stubEnv('TEAMS_BOT_APP_ID', 'bot-id');
    resolveEffectiveDeploymentEnvVarsMock.mockResolvedValue({
      TEAMS_BOT_APP_PASSWORD: 'saved-bot-secret',
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
      ROOMOTE_AUTH_MICROSOFT_CLIENT_ID: 'signin-id',
      ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET: 'signin-secret',
    });

    await resolveTeamsBotRuntimeCredentials();
    await resolveTeamsBotRuntimeCredentials();
    expect(resolveEffectiveDeploymentEnvVarsMock).toHaveBeenCalledTimes(1);

    invalidateTeamsBotRuntimeCredentialsCache();
    await resolveTeamsBotRuntimeCredentials();
    expect(resolveEffectiveDeploymentEnvVarsMock).toHaveBeenCalledTimes(2);
  });
});
