describe('isRoomoteGitHubLogin', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('recognizes configured and additional app logins', async () => {
    vi.doMock('@roomote/env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@roomote/env')>();

      return {
        ...actual,
        Env: {
          R_GITHUB_APP_SLUG: 'roomote-dev',
          R_GITHUB_ADDITIONAL_APP_SLUGS: ' roomote, , Acme,roomote ',
        },
      };
    });

    const { isRoomoteGitHubLogin } = await import('../schema');

    expect(isRoomoteGitHubLogin('roomote[bot]')).toBe(true);
    expect(isRoomoteGitHubLogin('app/roomote')).toBe(true);
    expect(isRoomoteGitHubLogin('roomote-dev[bot]')).toBe(true);
    expect(isRoomoteGitHubLogin('app/roomote-dev')).toBe(true);
    expect(isRoomoteGitHubLogin('acme[bot]')).toBe(true);
    expect(isRoomoteGitHubLogin('octocat')).toBe(false);
  });

  it('rejects unconfigured roomote-* prefix forms', async () => {
    vi.doMock('@roomote/env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@roomote/env')>();

      return {
        ...actual,
        Env: {
          R_GITHUB_APP_SLUG: 'roomote',
          R_GITHUB_ADDITIONAL_APP_SLUGS: '',
        },
      };
    });

    const { isRoomoteGitHubLogin } = await import('../schema');
    const { setConfiguredGitHubAppSlugCache } = await import('../app-slug');

    setConfiguredGitHubAppSlugCache(null);

    expect(isRoomoteGitHubLogin('roomote-staging[bot]')).toBe(false);
    expect(isRoomoteGitHubLogin('app/roomote-canary')).toBe(false);
    expect(isRoomoteGitHubLogin('dependabot[bot]')).toBe(false);
  });

  it('recognizes a database-configured app slug once resolved', async () => {
    vi.doMock('@roomote/env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@roomote/env')>();

      return {
        ...actual,
        Env: {
          R_GITHUB_APP_SLUG: 'roomote',
          R_GITHUB_ADDITIONAL_APP_SLUGS: 'trusted-reviewer',
        },
      };
    });

    const { isRoomoteGitHubLogin } = await import('../schema');
    const { setConfiguredGitHubAppSlugCache } = await import('../app-slug');

    // Before resolution the process-env default applies.
    expect(isRoomoteGitHubLogin('acme[bot]')).toBe(false);

    setConfiguredGitHubAppSlugCache({
      value: 'acme',
      expiresAt: Date.now() + 60_000,
    });

    expect(isRoomoteGitHubLogin('acme[bot]')).toBe(true);
    expect(isRoomoteGitHubLogin('app/acme')).toBe(true);
    expect(isRoomoteGitHubLogin('roomote[bot]')).toBe(false);
    expect(isRoomoteGitHubLogin('roomote-dev[bot]')).toBe(false);
    expect(isRoomoteGitHubLogin('roomote-preview[bot]')).toBe(false);
    expect(isRoomoteGitHubLogin('trusted-reviewer[bot]')).toBe(true);
    expect(isRoomoteGitHubLogin('octocat')).toBe(false);
  });
});

describe('isManagedRoomoteGitHubLogin', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('uses the configured and additional app slug allowlist', async () => {
    vi.doMock('@roomote/env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@roomote/env')>();

      return {
        ...actual,
        Env: {
          R_GITHUB_APP_SLUG: 'acme',
          R_GITHUB_ADDITIONAL_APP_SLUGS: ' roomote-community ',
        },
      };
    });

    const { isManagedRoomoteGitHubLogin } = await import('../schema');

    expect(isManagedRoomoteGitHubLogin('roomote-community[bot]')).toBe(true);
    expect(isManagedRoomoteGitHubLogin('acme[bot]')).toBe(true);
    expect(isManagedRoomoteGitHubLogin('roomote-unknown[bot]')).toBe(false);
  });
});
