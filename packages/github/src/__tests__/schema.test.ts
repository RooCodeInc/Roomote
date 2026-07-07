describe('isRoomoteGitHubLogin', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('recognizes both roomote and roomote-dev app logins', async () => {
    vi.doMock('@roomote/env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@roomote/env')>();

      return {
        ...actual,
        Env: { NEXT_PUBLIC_GITHUB_APP_SLUG: 'roomote-dev' },
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
});
