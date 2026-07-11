describe('isRoomoteGitHubLogin', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('recognizes both roomote and roomote-dev app logins', async () => {
    vi.doMock('@roomote/env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@roomote/env')>();

      return {
        ...actual,
        Env: { R_GITHUB_APP_SLUG: 'roomote-dev' },
      };
    });

    const { isRoomoteGitHubLogin } = await import('../schema');

    expect(isRoomoteGitHubLogin('roomote[bot]')).toBe(true);
    expect(isRoomoteGitHubLogin('app/roomote')).toBe(true);
    expect(isRoomoteGitHubLogin('roomote-dev[bot]')).toBe(true);
    expect(isRoomoteGitHubLogin('app/roomote-dev')).toBe(true);
    expect(isRoomoteGitHubLogin('roomote-dev[bot]')).toBe(true);
    expect(isRoomoteGitHubLogin('app/roomote-dev')).toBe(true);
    expect(isRoomoteGitHubLogin('octocat')).toBe(false);
  });

  it('recognizes a database-configured app slug once resolved', async () => {
    vi.doMock('@roomote/env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@roomote/env')>();

      return {
        ...actual,
        Env: { R_GITHUB_APP_SLUG: 'roomote' },
      };
    });

    const { isRoomoteGitHubLogin } = await import('../schema');
    const { setConfiguredGitHubAppSlugCache } = await import('../app-slug');

    // Before resolution the process-env default applies.
    expect(isRoomoteGitHubLogin('openmote[bot]')).toBe(false);

    setConfiguredGitHubAppSlugCache({
      value: 'openmote',
      expiresAt: Date.now() + 60_000,
    });

    expect(isRoomoteGitHubLogin('openmote[bot]')).toBe(true);
    expect(isRoomoteGitHubLogin('app/openmote')).toBe(true);
    // The hosted-product logins stay recognized alongside the configured one.
    expect(isRoomoteGitHubLogin('roomote[bot]')).toBe(true);
    expect(isRoomoteGitHubLogin('roomote-dev[bot]')).toBe(true);
    expect(isRoomoteGitHubLogin('octocat')).toBe(false);
  });
});
