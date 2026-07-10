import { getArtifactConfig, getRoomoteConfig } from '../config.js';

describe('roomote mcp config helpers', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.AUTH_TOKEN;
    delete process.env.ROOMOTE_CLOUD_TOKEN;
    delete process.env.ROOMOTE_PLATFORM_API_URL;
    delete process.env.TRPC_URL;
    delete process.env.ROOMOTE_WORKSPACE_PATH;
    delete process.env.ROOMOTE_AUTH_BYPASS_HEADER_NAME;
    delete process.env.ROOMOTE_AUTH_BYPASS_VALUE;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('uses the platform API URL for artifact operations', () => {
    process.env.ROOMOTE_CLOUD_TOKEN = 'run-token';
    process.env.ROOMOTE_PLATFORM_API_URL = 'https://platform.example.com';
    process.env.ROOMOTE_APP_URL = 'https://app.example.com';
    process.env.ROOMOTE_WORKSPACE_PATH = '/workspace';

    expect(getArtifactConfig()).toEqual({
      token: 'run-token',
      platformApiUrl: 'https://platform.example.com',
      workspacePath: '/workspace',
      authBypassHeaderName: undefined,
      authBypassHeaderValue: undefined,
    });
  });

  it('uses the configured platform API URL for roomote requests', () => {
    process.env.ROOMOTE_CLOUD_TOKEN = 'run-token';
    process.env.TRPC_URL = 'https://trpc.example.com';

    expect(getRoomoteConfig()).toEqual({
      token: 'run-token',
      platformApiUrl: 'https://trpc.example.com',
      authBypassHeaderName: undefined,
      authBypassHeaderValue: undefined,
    });
  });

  it('preserves pathful platform API URLs while removing trailing slashes', () => {
    process.env.ROOMOTE_CLOUD_TOKEN = 'run-token';
    process.env.ROOMOTE_PLATFORM_API_URL =
      'https://app.example.com/_roomote-api/';

    expect(getRoomoteConfig()).toEqual({
      token: 'run-token',
      platformApiUrl: 'https://app.example.com/_roomote-api',
      authBypassHeaderName: undefined,
      authBypassHeaderValue: undefined,
    });
  });

  it('falls back to the default platform API origin when no override is set', () => {
    process.env.ROOMOTE_CLOUD_TOKEN = 'run-token';

    expect(getRoomoteConfig()).toEqual({
      token: 'run-token',
      platformApiUrl: 'http://localhost:13001',
      authBypassHeaderName: undefined,
      authBypassHeaderValue: undefined,
    });
  });

  it('falls back to AUTH_TOKEN when ROOMOTE_CLOUD_TOKEN is unavailable', () => {
    process.env.AUTH_TOKEN = 'worker-run-token';
    process.env.TRPC_URL = 'https://trpc.example.com';
    process.env.ROOMOTE_WORKSPACE_PATH = '/workspace';

    expect(getArtifactConfig()).toEqual({
      token: 'worker-run-token',
      platformApiUrl: 'https://trpc.example.com',
      workspacePath: '/workspace',
      authBypassHeaderName: undefined,
      authBypassHeaderValue: undefined,
    });

    expect(getRoomoteConfig()).toEqual({
      token: 'worker-run-token',
      platformApiUrl: 'https://trpc.example.com',
      authBypassHeaderName: undefined,
      authBypassHeaderValue: undefined,
    });
  });

  it('returns null when the cloud token is missing', () => {
    expect(getArtifactConfig()).toBeNull();
    expect(getRoomoteConfig()).toBeNull();
  });
});
