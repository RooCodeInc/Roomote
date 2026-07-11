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
    Env: { R_GITHUB_APP_SLUG: 'roomote' },
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

  it('resolves the canonical R_GITHUB_APP_SLUG deployment env var', async () => {
    mockResolveDeploymentEnvVar.mockResolvedValueOnce('openmote');

    const { resolveConfiguredGitHubAppSlug } =
      await import('../resolve-app-slug');

    await expect(resolveConfiguredGitHubAppSlug()).resolves.toBe('openmote');
    expect(mockResolveDeploymentEnvVar).toHaveBeenCalledWith(
      'R_GITHUB_APP_SLUG',
    );
  });

  it('does not cache misses so a freshly saved slug is picked up', async () => {
    mockResolveDeploymentEnvVar.mockResolvedValue(null);

    const { resolveConfiguredGitHubAppSlug } =
      await import('../resolve-app-slug');

    await expect(resolveConfiguredGitHubAppSlug()).resolves.toBe('roomote');
    await expect(resolveConfiguredGitHubAppSlug()).resolves.toBe('roomote');

    expect(mockResolveDeploymentEnvVar).toHaveBeenCalledTimes(2);
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

describe('resolveConfiguredGitHubAppSlugIfConfigured', () => {
  beforeEach(() => {
    vi.resetModules();
    mockResolveDeploymentEnvVar.mockReset();
    delete process.env.R_GITHUB_APP_SLUG;
  });

  it('returns the configured slug when one is present', async () => {
    mockResolveDeploymentEnvVar.mockResolvedValueOnce('roomote-roomote');

    const { resolveConfiguredGitHubAppSlugIfConfigured } =
      await import('../resolve-app-slug');

    await expect(resolveConfiguredGitHubAppSlugIfConfigured()).resolves.toBe(
      'roomote-roomote',
    );
  });

  it('returns null when nothing is configured instead of the schema default', async () => {
    mockResolveDeploymentEnvVar.mockResolvedValueOnce(null);

    const { resolveConfiguredGitHubAppSlugIfConfigured } =
      await import('../resolve-app-slug');

    await expect(
      resolveConfiguredGitHubAppSlugIfConfigured(),
    ).resolves.toBeNull();
  });

  it('returns null on cold resolution failure so bodies are not downgraded', async () => {
    mockResolveDeploymentEnvVar.mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    const { resolveConfiguredGitHubAppSlugIfConfigured } =
      await import('../resolve-app-slug');

    await expect(
      resolveConfiguredGitHubAppSlugIfConfigured(),
    ).resolves.toBeNull();
  });
});
