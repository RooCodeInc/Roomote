import { describe, expect, it } from 'vitest';

import {
  CONTROL_PLANE_ENV_VAR_NAMES,
  DEFAULT_MODEL_PROVIDER_ENV_KEYS,
  getSourceControlTokenEnvVars,
} from '@roomote/types';

import { scrubOpenCodeHelperEnv } from '../opencode-helper-env';

describe('scrubOpenCodeHelperEnv', () => {
  it('removes service-level configuration the helper does not use', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/roomote',
      DATABASE_URL: 'postgres://postgres:password@postgres:5432/roomote',
      REDIS_URL: 'redis://redis:6379',
      ENCRYPTION_KEY: 'encryption-key',
      JOB_AUTH_PRIVATE_KEY: 'job-private-key',
      PREVIEW_AUTH_PRIVATE_KEY: 'preview-private-key',
      ARTIFACT_SIGNING_KEY: 'artifact-signing-key',
      BETTER_AUTH_SECRET: 'better-auth-secret',
      DASHBOARD_PASSWORD: 'dashboard-password',
      SETUP_TOKEN: 'setup-token',
      S3_SECRET_ACCESS_KEY: 's3-secret',
      R_DISCORD_BOT_TOKEN: 'discord-bot-token',
    };

    scrubOpenCodeHelperEnv(env);

    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/roomote' });
  });

  it('removes every name on the shared control-plane list', () => {
    // Includes credentials that are neither model-provider keys nor caught by
    // the suffix rule, such as the media and judgment-model API keys.
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      [...CONTROL_PLANE_ENV_VAR_NAMES].map((key) => [key, `${key}-value`]),
    );

    scrubOpenCodeHelperEnv(env);

    expect(CONTROL_PLANE_ENV_VAR_NAMES.has('R_ELEVENLABS_API_KEY')).toBe(true);
    expect(CONTROL_PLANE_ENV_VAR_NAMES.has('R_VOICE_OPENAI_API_KEY')).toBe(
      true,
    );
    expect(CONTROL_PLANE_ENV_VAR_NAMES.has('R_TYPESAFE_API_KEY')).toBe(true);
    // The hosting-managed inference key is on both lists; it only survives
    // when a caller passes it explicitly, which this call did not.
    expect(
      Object.keys(env).filter(
        (key) => !DEFAULT_MODEL_PROVIDER_ENV_KEYS.includes(key),
      ),
    ).toEqual([]);
  });

  it('removes all Brain service configuration, including file-backed tokens', () => {
    const env: NodeJS.ProcessEnv = {
      R_BRAIN_GATEWAY_TOKEN: 'brain-gateway-token',
      R_BRAIN_GATEWAY_TOKEN_FILE: '/run/secrets/brain-gateway-token',
      R_BRAIN_OPENROUTER_API_KEY: 'brain-openrouter-key',
      R_BRAIN_OPENAI_API_KEY: 'brain-openai-key',
      R_BRAIN_INFERENCE_UPSTREAM_API_KEY: 'brain-upstream-key',
      R_BRAIN_MODEL: 'openrouter/example',
      R_GBRAIN_ADMIN_TOKEN: 'gbrain-admin-token',
      R_GBRAIN_ADMIN_TOKEN_FILE: '/run/secrets/gbrain-admin-token',
      R_GBRAIN_AGENT_TOKEN: 'gbrain-agent-token',
      R_GBRAIN_URL: 'http://gbrain:8931',
      PATH: '/usr/bin',
    };

    scrubOpenCodeHelperEnv(env);

    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('removes platform-generated values, the launcher-only key, and run tokens', () => {
    const env: NodeJS.ProcessEnv = {
      SERVICE_PASSWORD_POSTGRES: 'generated-password',
      SERVICE_BASE64_64_ENCRYPTIONKEY: 'generated-key',
      SANDBOX_OPENROUTER_API_KEY: 'launcher-only-key',
      ROOMOTE_SERVICE_TOKEN_STRIPE: 'run-grant-token',
      ROOMOTE_CLOUD_TOKEN: 'run-token',
      AUTH_TOKEN: 'run-token',
      // Non-secret platform values are left alone.
      SERVICE_FQDN_WEB: 'roomote.example.com',
    };

    scrubOpenCodeHelperEnv(env);

    expect(env).toEqual({ SERVICE_FQDN_WEB: 'roomote.example.com' });
  });

  it('removes inherited source-control access tokens unless passed explicitly', () => {
    const inherited: NodeJS.ProcessEnv = {
      // Every per-provider name task runs receive, so a provider added later
      // is covered by this test without editing it.
      ...Object.fromEntries(
        getSourceControlTokenEnvVars().map((key) => [key, `${key}-value`]),
      ),
      GH_TOKEN: 'gh-token',
      BITBUCKET_OAUTH: 'bitbucket-oauth',
      // Legacy spelling.
      GITHUB_TOKEN: 'github-token',
      PATH: '/usr/bin',
    };

    const env = { ...inherited };
    scrubOpenCodeHelperEnv(env);
    expect(env).toEqual({ PATH: '/usr/bin' });

    const explicit = { ...inherited };
    scrubOpenCodeHelperEnv(explicit, { GITHUB_TOKEN: 'github-token' });
    expect(explicit).toEqual({
      GITHUB_TOKEN: 'github-token',
      PATH: '/usr/bin',
    });
  });

  it('removes unlisted configuration by its suffix', () => {
    const env: NodeJS.ProcessEnv = {
      R_FUTURE_CLIENT_SECRET: 'client-secret',
      R_FUTURE_APP_PRIVATE_KEY: 'private-key',
      R_FUTURE_REGISTRY_PASSWORD: 'password',
      // Ordinary config that is on no list is kept.
      R_APP_URL: 'https://roomote.example.com',
      NODE_ENV: 'production',
    };

    scrubOpenCodeHelperEnv(env);

    expect(env).toEqual({
      R_APP_URL: 'https://roomote.example.com',
      NODE_ENV: 'production',
    });
  });

  it('keeps every built-in model-provider credential', () => {
    // Removing one of these would break that provider for helper calls.
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      DEFAULT_MODEL_PROVIDER_ENV_KEYS.map((key) => [key, `${key}-value`]),
    );
    const before = { ...env };

    scrubOpenCodeHelperEnv(env);

    expect(env).toEqual(before);
  });

  it('keeps provider credentials that are not in the built-in list', () => {
    const env: NodeJS.ProcessEnv = {
      // Bedrock's standard credential chain and proxy settings.
      AWS_ACCESS_KEY_ID: 'aws-access-key-id',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-access-key',
      AWS_SESSION_TOKEN: 'aws-session-token',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/aws/token',
      HTTPS_PROXY: 'http://proxy.internal:3128',
    };
    const before = { ...env };

    scrubOpenCodeHelperEnv(env);

    expect(env).toEqual(before);
  });

  it('keeps a key the operator declared as a model credential', () => {
    const env: NodeJS.ProcessEnv = {
      R_MODEL_ENV_KEYS: 'CORP_GATEWAY_CLIENT_SECRET',
      CORP_GATEWAY_CLIENT_SECRET: 'gateway-secret',
      R_GITHUB_CLIENT_SECRET: 'github-secret',
    };

    scrubOpenCodeHelperEnv(env);

    expect(env).toEqual({
      R_MODEL_ENV_KEYS: 'CORP_GATEWAY_CLIENT_SECRET',
      CORP_GATEWAY_CLIENT_SECRET: 'gateway-secret',
    });
  });

  it('keeps anything the caller passed explicitly', () => {
    const env: NodeJS.ProcessEnv = {
      ROOMOTE_FAST_TOOL_BRIDGE_TOKEN: 'bridge-token',
      CANDIDATE_PROVIDER_PASSWORD: 'candidate',
      DASHBOARD_PASSWORD: 'dashboard-password',
    };

    scrubOpenCodeHelperEnv(env, {
      CANDIDATE_PROVIDER_PASSWORD: 'candidate',
      // Explicitly unset by the caller, so it is not a kept key.
      DASHBOARD_PASSWORD: undefined,
    });

    expect(env).toEqual({
      ROOMOTE_FAST_TOOL_BRIDGE_TOKEN: 'bridge-token',
      CANDIDATE_PROVIDER_PASSWORD: 'candidate',
    });
  });
});
