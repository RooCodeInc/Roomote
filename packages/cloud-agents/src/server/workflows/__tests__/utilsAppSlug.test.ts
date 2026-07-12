// pnpm --filter @roomote/cloud-agents test src/server/workflows/__tests__/utilsAppSlug.test.ts

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      R_GITHUB_APP_SLUG: 'octomote',
    },
  };
});

import { setConfiguredGitHubAppSlugCache, type Schemas } from '@roomote/github';

import { DEFAULT_ROOMOTE_COMMIT_AUTHOR } from '../../commit-author';
import {
  findReusableReviewSummaryComment,
  getPrBodyAttributionLine,
} from '../utils';

function makeReviewSummaryComment(login: string): Schemas.IssueComment {
  return {
    id: 1,
    body: '<!-- roomote-review-summary sha=abc mode=initial -->\nReviewing.',
    url: 'https://github.com/acme/repo/issues/1#issuecomment-1',
    user: { id: 100, login, type: 'Bot' },
    created_at: '2026-07-10T00:00:00Z',
    updated_at: '2026-07-10T00:00:00Z',
  };
}

afterEach(() => {
  setConfiguredGitHubAppSlugCache(null);
});

describe('findReusableReviewSummaryComment', () => {
  it('recognizes the process-env app slug bot as the summary author', () => {
    const comment = makeReviewSummaryComment('octomote[bot]');

    expect(findReusableReviewSummaryComment([comment])).toBe(comment);
  });

  it('does not reuse summaries from an unrelated bot', () => {
    const comment = makeReviewSummaryComment('acme[bot]');

    expect(findReusableReviewSummaryComment([comment])).toBeUndefined();
  });

  it('recognizes the database-configured app slug bot once cached', () => {
    setConfiguredGitHubAppSlugCache({
      value: 'acme',
      expiresAt: Date.now() + 60_000,
    });

    const comment = makeReviewSummaryComment('acme[bot]');

    expect(findReusableReviewSummaryComment([comment])).toBe(comment);
  });
});

describe('getPrBodyAttributionLine', () => {
  it('always advertises the canonical @roomote mention', () => {
    const line = getPrBodyAttributionLine({
      attribution: DEFAULT_ROOMOTE_COMMIT_AUTHOR,
      taskUrl: 'https://app.roomote.dev/tasks/123',
    });

    expect(line).toContain('@roomote');
    expect(line).not.toContain('@octomote');
  });

  it('ignores the database-configured app slug for the advertised mention', () => {
    setConfiguredGitHubAppSlugCache({
      value: 'acme',
      expiresAt: Date.now() + 60_000,
    });

    const line = getPrBodyAttributionLine({
      attribution: DEFAULT_ROOMOTE_COMMIT_AUTHOR,
      taskUrl: 'https://app.roomote.dev/tasks/123',
    });

    expect(line).toContain('@roomote');
    expect(line).not.toContain('@acme');
  });
});
