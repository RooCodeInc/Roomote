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

import { Env } from '@roomote/env';
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

  it('returns false for a longer login that starts with the slug', () => {
    expect(
      isMention({
        body: 'cc @roomote-fan on this one',
        user: { login: 'testuser' },
      }),
    ).toBe(false);
  });

  it('returns false for email addresses containing the slug', () => {
    expect(
      isMention({
        body: 'forwarded from grace@roomote.onmicrosoft.com',
        user: { login: 'testuser' },
      }),
    ).toBe(false);
  });

  it('returns true when the mention is followed by punctuation', () => {
    expect(
      isMention({
        body: 'thanks @roomote!',
        user: { login: 'testuser' },
      }),
    ).toBe(true);
  });

  it('returns true when the mention starts the comment', () => {
    expect(
      isMention({
        body: '@roomote please rerun the review',
        user: { login: 'testuser' },
      }),
    ).toBe(true);
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

    it('still detects the canonical @roomote alias', () => {
      expect(
        isMention({
          body: 'Hey @roomote can you take a look?',
          user: { login: 'testuser' },
        }),
      ).toBe(true);
    });

    it('applies word boundaries to the canonical alias too', () => {
      expect(
        isMention({
          body: 'cc @roomote-fan on this one',
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

  describe('with the canonical alias disabled', () => {
    const mutableEnv = Env as Record<string, string | undefined>;

    beforeEach(() => {
      mutableEnv.R_GITHUB_DISABLE_CANONICAL_MENTION = 'true';
      setConfiguredGitHubAppSlugCache({
        value: 'acme',
        expiresAt: Date.now() + 60_000,
      });
    });

    afterEach(() => {
      delete mutableEnv.R_GITHUB_DISABLE_CANONICAL_MENTION;
      setConfiguredGitHubAppSlugCache(null);
    });

    it('ignores the canonical alias', () => {
      expect(
        isMention({
          body: 'Hey @roomote can you take a look?',
          user: { login: 'testuser' },
        }),
      ).toBe(false);
    });

    it('still detects the configured slug', () => {
      expect(
        isMention({
          body: 'Hey @acme can you take a look?',
          user: { login: 'testuser' },
        }),
      ).toBe(true);
    });
  });
});
