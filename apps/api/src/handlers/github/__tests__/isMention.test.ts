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

import {
  setConfiguredGitHubAppSlugCache,
  setGitHubRoomoteMentionSettingCache,
} from '@roomote/github';

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
      setGitHubRoomoteMentionSettingCache(null);
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

  describe('with a Roomote-branded app slug', () => {
    beforeEach(() => {
      setConfiguredGitHubAppSlugCache({
        value: 'roomote-roomote',
        expiresAt: Date.now() + 60_000,
      });
    });

    afterEach(() => {
      setConfiguredGitHubAppSlugCache(null);
    });

    it('detects the @Roomote shorthand', () => {
      expect(
        isMention({
          body: '@Roomote please take a look',
          user: { login: 'testuser' },
        }),
      ).toBe(true);
    });

    it('still detects the full configured slug', () => {
      expect(
        isMention({
          body: '@roomote-roomote please take a look',
          user: { login: 'testuser' },
        }),
      ).toBe(true);
    });

    it('does not treat a longer shorthand lookalike as a mention', () => {
      expect(
        isMention({
          body: '@roomote-helper please take a look',
          user: { login: 'testuser' },
        }),
      ).toBe(false);
    });

    it('only detects the full configured slug after opting out', () => {
      setGitHubRoomoteMentionSettingCache({
        value: false,
      });

      expect(
        isMention({
          body: '@Roomote please take a look',
          user: { login: 'testuser' },
        }),
      ).toBe(false);
      expect(
        isMention({
          body: '@roomote-roomote please take a look',
          user: { login: 'testuser' },
        }),
      ).toBe(true);
    });
  });
});
