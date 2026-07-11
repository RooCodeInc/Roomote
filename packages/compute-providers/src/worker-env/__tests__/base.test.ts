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

  it('forwards deployment model config and provider keys to workers', () => {
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
    expect(env.OPENROUTER_API_KEY).toBe('openrouter-key');
    expect(env.CUSTOM_PROVIDER_API_KEY).toBe('custom-provider-key');
  });

  it('forwards Vercel AI Gateway credentials through the shared provider key list', () => {
    process.env.R_MODEL = 'vercel/openai/gpt-5.4';
    process.env.AI_GATEWAY_API_KEY = 'vercel-key';

    const env = buildBaseWorkerEnv({
      authToken: 'auth-token',
      extraEnv: {},
    });

    expect(env.R_MODEL).toBe('vercel/openai/gpt-5.4');
    expect(env.AI_GATEWAY_API_KEY).toBe('vercel-key');
  });
});
