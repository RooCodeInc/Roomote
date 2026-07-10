// pnpm --filter @roomote/github test src/__tests__/resolve-app-slug.test.ts

const { mockResolveDeploymentEnvVar } = vi.hoisted(() => ({
  mockResolveDeploymentEnvVar: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  resolveDeploymentEnvVar: mockResolveDeploymentEnvVar,
}));

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: { NEXT_PUBLIC_GITHUB_APP_SLUG: 'roomote' },
  };
});

describe('resolveConfiguredGitHubAppSlug', () => {
  beforeEach(() => {
    vi.resetModules();
    mockResolveDeploymentEnvVar.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves the configured slug and caches non-empty values', async () => {
    mockResolveDeploymentEnvVar.mockResolvedValueOnce('openmote');

    const { resolveConfiguredGitHubAppSlug } =
      await import('../resolve-app-slug');
    const { getEffectiveGitHubAppSlug } = await import('../app-slug');

    await expect(resolveConfiguredGitHubAppSlug()).resolves.toBe('openmote');
    expect(getEffectiveGitHubAppSlug()).toBe('openmote');

    await expect(resolveConfiguredGitHubAppSlug()).resolves.toBe('openmote');
    expect(mockResolveDeploymentEnvVar).toHaveBeenCalledTimes(1);
  });

  it('falls back to the GITHUB_APP_SLUG alias', async () => {
    mockResolveDeploymentEnvVar
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('openmote');

    const { resolveConfiguredGitHubAppSlug } =
      await import('../resolve-app-slug');

    await expect(resolveConfiguredGitHubAppSlug()).resolves.toBe('openmote');
    expect(mockResolveDeploymentEnvVar).toHaveBeenNthCalledWith(
      1,
      'NEXT_PUBLIC_GITHUB_APP_SLUG',
    );
    expect(mockResolveDeploymentEnvVar).toHaveBeenNthCalledWith(
      2,
      'GITHUB_APP_SLUG',
    );
  });

  it('does not cache misses so a freshly saved slug is picked up', async () => {
    mockResolveDeploymentEnvVar.mockResolvedValue(null);

    const { resolveConfiguredGitHubAppSlug } =
      await import('../resolve-app-slug');

    await expect(resolveConfiguredGitHubAppSlug()).resolves.toBe('roomote');
    await expect(resolveConfiguredGitHubAppSlug()).resolves.toBe('roomote');

    // Two aliases checked on each of the two calls.
    expect(mockResolveDeploymentEnvVar).toHaveBeenCalledTimes(4);
  });

  it('re-resolves after the cache expires', async () => {
    vi.useFakeTimers();
    mockResolveDeploymentEnvVar.mockResolvedValue('openmote');

    const { resolveConfiguredGitHubAppSlug } =
      await import('../resolve-app-slug');

    await expect(resolveConfiguredGitHubAppSlug()).resolves.toBe('openmote');
    vi.advanceTimersByTime(61_000);
    await expect(resolveConfiguredGitHubAppSlug()).resolves.toBe('openmote');

    expect(mockResolveDeploymentEnvVar).toHaveBeenCalledTimes(2);
  });

  it('keeps the last known slug when the database is unavailable', async () => {
    vi.useFakeTimers();
    mockResolveDeploymentEnvVar.mockResolvedValueOnce('openmote');

    const { resolveConfiguredGitHubAppSlug } =
      await import('../resolve-app-slug');

    await expect(resolveConfiguredGitHubAppSlug()).resolves.toBe('openmote');

    vi.advanceTimersByTime(61_000);
    mockResolveDeploymentEnvVar.mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    await expect(resolveConfiguredGitHubAppSlug()).resolves.toBe('openmote');
  });

  it('falls back to the process-env slug when resolution fails cold', async () => {
    mockResolveDeploymentEnvVar.mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    const { resolveConfiguredGitHubAppSlug } =
      await import('../resolve-app-slug');

    await expect(resolveConfiguredGitHubAppSlug()).resolves.toBe('roomote');
  });
});
