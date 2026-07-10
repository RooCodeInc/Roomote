const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    APP_ENV: 'production' as string | undefined,
    R_APP_URL: 'https://app.example.com',
    R_PUBLIC_URL: undefined as string | undefined,
  },
}));

vi.mock('@roomote/env', () => ({ Env: mockEnv }));

// The allowlist is resolved once at module load, so reload the module after
// setting the configured URLs to exercise different deployments.
async function loadResolver() {
  vi.resetModules();
  return (await import('../cors')).resolveApiCorsOrigin;
}

describe('resolveApiCorsOrigin', () => {
  beforeEach(() => {
    mockEnv.APP_ENV = 'production';
    mockEnv.R_APP_URL = 'https://app.example.com';
    mockEnv.R_PUBLIC_URL = undefined;
  });

  it('reflects a configured app origin in production', async () => {
    const resolve = await loadResolver();
    expect(resolve('https://app.example.com')).toBe('https://app.example.com');
  });

  it('rejects an unconfigured origin in production', async () => {
    const resolve = await loadResolver();
    expect(resolve('https://evil.example.com')).toBeNull();
  });

  it('also allows the configured public URL origin', async () => {
    mockEnv.R_PUBLIC_URL = 'https://roomote.ngrok.app';
    const resolve = await loadResolver();
    expect(resolve('https://roomote.ngrok.app')).toBe(
      'https://roomote.ngrok.app',
    );
  });

  it('passes through requests with no Origin header', async () => {
    const resolve = await loadResolver();
    expect(resolve('')).toBe('');
  });

  it('is permissive in development', async () => {
    mockEnv.APP_ENV = 'development';
    const resolve = await loadResolver();
    expect(resolve('http://localhost:5173')).toBe('http://localhost:5173');
  });

  it('rejects an unconfigured origin in preview', async () => {
    mockEnv.APP_ENV = 'preview';
    const resolve = await loadResolver();
    expect(resolve('https://evil.example.com')).toBeNull();
  });
});
