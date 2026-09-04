vi.mock('@roomote/env', () => ({
  Env: {
    R_APP_URL: 'https://web.roomote.example.com',
    TRPC_URL: 'https://api.roomote.example.com',
  },
}));

import { buildBaseWorkerEnv } from '../base';

describe('buildBaseWorkerEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PREVIEW_PROXY_BASE_URL;
    delete process.env.JOB_AUTH_PRIVATE_KEY;
    delete process.env.JOB_AUTH_PUBLIC_KEY;
    delete process.env.R_MODEL;
    delete process.env.R_SMALL_MODEL;
    delete process.env.R_VISION_MODEL;
    delete process.env.R_CODE_REVIEW_MODEL;
    delete process.env.R_EXPLORE_MODEL;
    delete process.env.R_PLANNING_MODEL;
    delete process.env.R_MODEL_REASONING_EFFORT;
    delete process.env.R_SMALL_MODEL_REASONING_EFFORT;
    delete process.env.R_VISION_MODEL_REASONING_EFFORT;
    delete process.env.R_CODE_REVIEW_MODEL_REASONING_EFFORT;
    delete process.env.R_EXPLORE_MODEL_REASONING_EFFORT;
    delete process.env.R_PLANNING_MODEL_REASONING_EFFORT;
    delete process.env.R_MODEL_ENV_KEYS;
    delete process.env.SANDBOX_OPENROUTER_API_KEY;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.MISTRAL_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('does not synthesize a preview proxy base URL when explicit config is absent', () => {
    const env = buildBaseWorkerEnv({
      authToken: 'auth-token',
      extraEnv: {},
    });

    expect(env.R_APP_URL).toBe('https://web.roomote.example.com');
    expect(env.TRPC_URL).toBe('https://api.roomote.example.com');
    expect(env.PREVIEW_PROXY_BASE_URL).toBeUndefined();
  });

  it('injects the legacy ROOMOTE_APP_URL alias for pre-rename snapshot workers', () => {
    const env = buildBaseWorkerEnv({
      authToken: 'auth-token',
      extraEnv: {},
    });

    expect(env.ROOMOTE_APP_URL).toBe(env.R_APP_URL);
  });

  it('forwards an explicit preview proxy base URL', () => {
    process.env.PREVIEW_PROXY_BASE_URL = 'https://preview.example.com';

    const env = buildBaseWorkerEnv({
      authToken: 'auth-token',
      extraEnv: {},
    });

    expect(env.PREVIEW_PROXY_BASE_URL).toBe('https://preview.example.com');
  });

  it('forwards only public launcher auth transport keys for the sandbox worker runtime', () => {
    process.env.JOB_AUTH_PRIVATE_KEY = 'job-private-key';
    process.env.JOB_AUTH_PUBLIC_KEY = 'job-public-key';

    const env = buildBaseWorkerEnv({
      authToken: 'auth-token',
      extraEnv: {},
    });

    expect(env.JOB_AUTH_PRIVATE_KEY).toBeUndefined();
    expect(env.JOB_AUTH_PUBLIC_KEY).toBe('job-public-key');
  });

  it('blocks job auth private keys from caller-provided extra env', () => {
    const env = buildBaseWorkerEnv({
      authToken: 'auth-token',
      extraEnv: {
        JOB_AUTH_PRIVATE_KEY: 'extra-private-key',
        SAFE_CONTEXT: 'safe-value',
      },
    });

    expect(env.JOB_AUTH_PRIVATE_KEY).toBeUndefined();
    expect(env.SAFE_CONTEXT).toBe('safe-value');
  });

  it('blocks disabled-provider credentials from operator and extra env', () => {
    process.env.R_MODEL = 'mistral/mistral-large-latest';
    process.env.R_MODEL_ENV_KEYS =
      'GOOGLE_APPLICATION_CREDENTIALS,MISTRAL_API_KEY';
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '{"type":"service_account"}';
    process.env.MISTRAL_API_KEY = 'mistral-operator-key';

    const env = buildBaseWorkerEnv({
      authToken: 'auth-token',
      extraEnv: {
        GOOGLE_APPLICATION_CREDENTIALS: '/run/secrets/google.json',
        MISTRAL_API_KEY: 'mistral-extra-key',
        R_SMALL_MODEL: 'mistral/mistral-small-latest',
      },
    });

    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.MISTRAL_API_KEY).toBeUndefined();
    expect(env.R_MODEL).toBeUndefined();
    expect(env.R_SMALL_MODEL).toBeUndefined();
  });

  it('forwards deployment model config and custom provider keys to workers', () => {
    process.env.R_MODEL = 'openrouter/openai/gpt-5.4';
    process.env.R_SMALL_MODEL = 'openrouter/openai/gpt-5.4-mini';
    process.env.R_VISION_MODEL = 'openrouter/openai/gpt-5.5';
    process.env.R_CODE_REVIEW_MODEL = 'openrouter/openai/gpt-5.5';
    process.env.R_EXPLORE_MODEL = 'openrouter/openai/gpt-5.4-mini';
    process.env.R_PLANNING_MODEL = 'openrouter/anthropic/claude-opus-4.7';
    process.env.R_MODEL_REASONING_EFFORT = 'high';
    process.env.R_SMALL_MODEL_REASONING_EFFORT = 'low';
    process.env.R_VISION_MODEL_REASONING_EFFORT = 'medium';
    process.env.R_CODE_REVIEW_MODEL_REASONING_EFFORT = 'high';
    process.env.R_EXPLORE_MODEL_REASONING_EFFORT = 'low';
    process.env.R_PLANNING_MODEL_REASONING_EFFORT = 'high';
    process.env.R_MODEL_ENV_KEYS = 'CUSTOM_PROVIDER_API_KEY';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';
    process.env.CUSTOM_PROVIDER_API_KEY = 'custom-provider-key';

    const env = buildBaseWorkerEnv({
      authToken: 'auth-token',
      extraEnv: {},
    });

    expect(env.R_MODEL).toBe('openrouter/openai/gpt-5.4');
    expect(env.R_SMALL_MODEL).toBe('openrouter/openai/gpt-5.4-mini');
    expect(env.R_VISION_MODEL).toBe('openrouter/openai/gpt-5.5');
    expect(env.R_CODE_REVIEW_MODEL).toBe('openrouter/openai/gpt-5.5');
    expect(env.R_EXPLORE_MODEL).toBe('openrouter/openai/gpt-5.4-mini');
    expect(env.R_PLANNING_MODEL).toBe('openrouter/anthropic/claude-opus-4.7');
    expect(env.R_MODEL_REASONING_EFFORT).toBe('high');
    expect(env.R_SMALL_MODEL_REASONING_EFFORT).toBe('low');
    expect(env.R_VISION_MODEL_REASONING_EFFORT).toBe('medium');
    expect(env.R_CODE_REVIEW_MODEL_REASONING_EFFORT).toBe('high');
    expect(env.R_EXPLORE_MODEL_REASONING_EFFORT).toBe('low');
    expect(env.R_PLANNING_MODEL_REASONING_EFFORT).toBe('high');
    expect(env.R_MODEL_ENV_KEYS).toBe('CUSTOM_PROVIDER_API_KEY');
    // Gateway-covered keys stay on the control plane; only custom provider
    // credentials the gateway cannot serve reach the worker.
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.CUSTOM_PROVIDER_API_KEY).toBe('custom-provider-key');
  });

  it('holds back gateway-covered provider keys from the worker env', () => {
    process.env.R_MODEL = 'anthropic/claude-sonnet-5';
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';
    process.env.AI_GATEWAY_API_KEY = 'vercel-key';
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'bedrock-key';
    process.env.XAI_API_KEY = 'xai-key';
    process.env.SANDBOX_OPENROUTER_API_KEY = 'sandbox-openrouter-key';
    process.env.AWS_REGION = 'us-west-2';

    const env = buildBaseWorkerEnv({
      authToken: 'auth-token',
      extraEnv: {
        SANDBOX_OPENROUTER_API_KEY: 'extra-sandbox-openrouter-key',
      },
    });

    expect(env.R_MODEL).toBe('anthropic/claude-sonnet-5');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.AI_GATEWAY_API_KEY).toBeUndefined();
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.SANDBOX_OPENROUTER_API_KEY).toBeUndefined();
    // Region config is not a secret and Bedrock's Mantle merge still
    // validates it sandbox-side.
    expect(env.AWS_REGION).toBe('us-west-2');
  });

  it('forwards the capped preview key only to environment workers', () => {
    process.env.SANDBOX_OPENROUTER_API_KEY = 'sandbox-openrouter-key';

    const environmentEnv = buildBaseWorkerEnv({
      authToken: 'auth-token',
      environmentId: 'environment-1',
    });
    const repositoryEnv = buildBaseWorkerEnv({ authToken: 'auth-token' });

    expect(environmentEnv.SANDBOX_OPENROUTER_API_KEY).toBe(
      'sandbox-openrouter-key',
    );
    expect(environmentEnv).not.toHaveProperty('OPENROUTER_API_KEY');
    expect(repositoryEnv).not.toHaveProperty('SANDBOX_OPENROUTER_API_KEY');
  });
});
