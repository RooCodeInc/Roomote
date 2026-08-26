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

import {
  setConfiguredGitHubAppSlugCache,
  setGitHubRoomoteMentionSettingCache,
  type Schemas,
} from '@roomote/github';
import {
  PR_BODY_ATTRIBUTION_END_MARKER,
  PR_BODY_ATTRIBUTION_START_MARKER,
} from '@roomote/types';

import { DEFAULT_ROOMOTE_COMMIT_AUTHOR } from '../../commit-author';
import {
  findReusableReviewSummaryComment,
  getPrBodyAttributionLine,
} from '../utils';

function makeReviewSummaryComment(login: string): Schemas.IssueComment {
  return {
    id: 1,
    body: '<!-- roomote-review-summary sha=abc1234 mode=initial -->\nReviewing.',
    url: 'https://github.com/acme/repo/issues/1#issuecomment-1',
    user: { id: 100, login, type: 'Bot' },
    created_at: '2026-07-10T00:00:00Z',
    updated_at: '2026-07-10T00:00:00Z',
  };
}

afterEach(() => {
  setConfiguredGitHubAppSlugCache(null);
  setGitHubRoomoteMentionSettingCache(null);
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
  it('mentions @roomote by default', () => {
    const line = getPrBodyAttributionLine({
      attribution: DEFAULT_ROOMOTE_COMMIT_AUTHOR,
      taskUrl: 'https://app.roomote.dev/tasks/123',
    });

    expect(line).toContain('@roomote');
    expect(line).not.toContain('@octomote');
    expect(line).toContain(PR_BODY_ATTRIBUTION_START_MARKER);
    expect(line).toContain(PR_BODY_ATTRIBUTION_END_MARKER);
  });

  it('mentions @roomote with a database-configured app slug', () => {
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
    expect(line).not.toContain('@octomote');
  });

  it('uses the shorter Roomote mention when enabled', () => {
    setConfiguredGitHubAppSlugCache({
      value: 'roomote-roomote',
      expiresAt: Date.now() + 60_000,
    });

    const line = getPrBodyAttributionLine({
      attribution: DEFAULT_ROOMOTE_COMMIT_AUTHOR,
      taskUrl: 'https://app.roomote.dev/tasks/123',
    });

    expect(line).toContain('@roomote');
    expect(line).not.toContain('@roomote-roomote');
  });

  it('uses the full configured app mention when disabled', () => {
    setConfiguredGitHubAppSlugCache({
      value: 'acme',
      expiresAt: Date.now() + 60_000,
    });
    setGitHubRoomoteMentionSettingCache({
      value: false,
    });

    const line = getPrBodyAttributionLine({
      attribution: DEFAULT_ROOMOTE_COMMIT_AUTHOR,
      taskUrl: 'https://app.roomote.dev/tasks/123',
    });

    expect(line).toContain('@acme');
    expect(line).not.toContain('@roomote');
  });

  it('accepts an explicit app slug and mention setting at write time', () => {
    const line = getPrBodyAttributionLine({
      attribution: DEFAULT_ROOMOTE_COMMIT_AUTHOR,
      taskUrl: 'https://app.roomote.dev/tasks/123',
      githubAppSlug: 'acme',
      roomoteMentionEnabled: false,
    });

    expect(line).toContain('@acme');
    expect(line).not.toContain('@roomote');
  });
});
