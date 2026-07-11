// pnpm --filter @roomote/api test src/handlers/github/__tests__/isMention.test.ts

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      R_GITHUB_APP_SLUG: 'roomote',
    },
  };
});

import { setConfiguredGitHubAppSlugCache } from '@roomote/github';

import { isMention } from '../isMention';

describe('isMention', () => {
  it('returns true for lowercase mentions', () => {
    expect(
      isMention({
        body: 'Hey @roomote can you take a look?',
        user: { login: 'testuser' },
      }),
    ).toBe(true);
  });

  it('returns true for uppercase mentions', () => {
    expect(
      isMention({
        body: 'Hey @ROOMOTE can you take a look?',
        user: { login: 'testuser' },
      }),
    ).toBe(true);
  });

  it('returns true for mixed-case mentions', () => {
    expect(
      isMention({
        body: 'Hey @Roomote can you take a look?',
        user: { login: 'testuser' },
      }),
    ).toBe(true);
  });

  it('returns false when the comment does not mention the app', () => {
    expect(
      isMention({
        body: 'This is just a regular comment',
        user: { login: 'testuser' },
      }),
    ).toBe(false);
  });

  it('returns false for bot-authored comments', () => {
    expect(
      isMention({
        body: 'Hey @roomote can you take a look?',
        user: { login: 'roomote[bot]' },
      }),
    ).toBe(false);
  });

  it('returns false for app-authored comments', () => {
    expect(
      isMention({
        body: 'Hey @roomote can you take a look?',
        user: { login: 'app/roomote' },
      }),
    ).toBe(false);
  });

  it('returns false when the comment user is null', () => {
    expect(
      isMention({
        body: 'Hey @roomote can you take a look?',
        user: null,
      }),
    ).toBe(false);
  });

  describe('with a database-configured app slug', () => {
    beforeEach(() => {
      setConfiguredGitHubAppSlugCache({
        value: 'acme',
        expiresAt: Date.now() + 60_000,
      });
    });

    afterEach(() => {
      setConfiguredGitHubAppSlugCache(null);
    });

    it('detects mentions of the configured slug', () => {
      expect(
        isMention({
          body: 'Hey @acme can you take a look?',
          user: { login: 'testuser' },
        }),
      ).toBe(true);
    });

    it('ignores mentions of the default slug when another slug is configured', () => {
      expect(
        isMention({
          body: 'Hey @roomote can you take a look?',
          user: { login: 'testuser' },
        }),
      ).toBe(false);
    });

    it('returns false for comments authored by the configured bot', () => {
      expect(
        isMention({
          body: 'Hey @acme can you take a look?',
          user: { login: 'acme[bot]' },
        }),
      ).toBe(false);
    });
  });
});
