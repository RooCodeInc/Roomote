describe('isRepoSkipped', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should return false when GITHUB_AUTOMATED_SKIP_REPOS is not set', async () => {
    vi.doMock('@roomote/env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@roomote/env')>();

      return {
        ...actual,
        Env: {
          GITHUB_AUTOMATED_SKIP_REPOS: undefined,
          GITHUB_AUTOMATED_SKIP_OWNERS: undefined,
        },
      };
    });

    const { isRepoSkipped } = await import('../is-repo-skipped');
    expect(isRepoSkipped('Roomote/example-app')).toBe(false);
  });

  it('should return false when GITHUB_AUTOMATED_SKIP_REPOS is empty', async () => {
    vi.doMock('@roomote/env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@roomote/env')>();

      return {
        ...actual,
        Env: {
          GITHUB_AUTOMATED_SKIP_REPOS: '',
          GITHUB_AUTOMATED_SKIP_OWNERS: '',
        },
      };
    });

    const { isRepoSkipped } = await import('../is-repo-skipped');
    expect(isRepoSkipped('Roomote/example-app')).toBe(false);
  });

  it('should return true for a repo in the skip list', async () => {
    vi.doMock('@roomote/env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@roomote/env')>();

      return {
        ...actual,
        Env: {
          GITHUB_AUTOMATED_SKIP_REPOS:
            'Roomote/example-app,Roomote/example-app,Roomote/example-cloud',
          GITHUB_AUTOMATED_SKIP_OWNERS: undefined,
        },
      };
    });

    const { isRepoSkipped } = await import('../is-repo-skipped');
    expect(isRepoSkipped('Roomote/example-app')).toBe(true);
    expect(isRepoSkipped('Roomote/example-app')).toBe(true);
    expect(isRepoSkipped('Roomote/example-cloud')).toBe(true);
  });

  it('should return false for a repo not in the skip list', async () => {
    vi.doMock('@roomote/env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@roomote/env')>();

      return {
        ...actual,
        Env: {
          GITHUB_AUTOMATED_SKIP_REPOS: 'Roomote/example-app',
          GITHUB_AUTOMATED_SKIP_OWNERS: undefined,
        },
      };
    });

    const { isRepoSkipped } = await import('../is-repo-skipped');
    expect(isRepoSkipped('Roomote/SomeOtherRepo')).toBe(false);
  });

  it('should be case-insensitive', async () => {
    vi.doMock('@roomote/env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@roomote/env')>();

      return {
        ...actual,
        Env: {
          GITHUB_AUTOMATED_SKIP_REPOS: 'Roomote/example-app',
          GITHUB_AUTOMATED_SKIP_OWNERS: undefined,
        },
      };
    });

    const { isRepoSkipped } = await import('../is-repo-skipped');
    expect(isRepoSkipped('roomote/example-app')).toBe(true);
    expect(isRepoSkipped('ROOMOTE/EXAMPLE-APP')).toBe(true);
  });

  it('should handle whitespace around repo names', async () => {
    vi.doMock('@roomote/env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@roomote/env')>();

      return {
        ...actual,
        Env: {
          GITHUB_AUTOMATED_SKIP_REPOS:
            ' Roomote/example-app , Roomote/example-app ',
          GITHUB_AUTOMATED_SKIP_OWNERS: undefined,
        },
      };
    });

    const { isRepoSkipped } = await import('../is-repo-skipped');
    expect(isRepoSkipped('Roomote/example-app')).toBe(true);
    expect(isRepoSkipped('Roomote/example-app')).toBe(true);
  });

  it('should return true for repos owned by a skipped owner', async () => {
    vi.doMock('@roomote/env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@roomote/env')>();

      return {
        ...actual,
        Env: {
          GITHUB_AUTOMATED_SKIP_REPOS: undefined,
          GITHUB_AUTOMATED_SKIP_OWNERS: 'Roomote',
        },
      };
    });

    const { isRepoSkipped } = await import('../is-repo-skipped');
    expect(isRepoSkipped('Roomote/example-app')).toBe(true);
    expect(isRepoSkipped('Roomote/example-app')).toBe(true);
    expect(isRepoSkipped('SomeOtherOrg/Roomote')).toBe(false);
  });

  it('should handle whitespace and case for skipped owners', async () => {
    vi.doMock('@roomote/env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@roomote/env')>();

      return {
        ...actual,
        Env: {
          GITHUB_AUTOMATED_SKIP_REPOS: undefined,
          GITHUB_AUTOMATED_SKIP_OWNERS: ' Roomote , SomeOtherOrg ',
        },
      };
    });

    const { isRepoSkipped } = await import('../is-repo-skipped');
    expect(isRepoSkipped('roomote/example-app')).toBe(true);
    expect(isRepoSkipped('SOMEOTHERORG/repo')).toBe(true);
    expect(isRepoSkipped('DifferentOrg/repo')).toBe(false);
  });
});
