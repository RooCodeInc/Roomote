vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      R_GITHUB_APP_SLUG: 'newmote',
    },
  };
});

import { setConfiguredGitHubAppSlugCache } from '@roomote/github';

import { buildGitHubRoutingPrompt } from '../prompts/github-routing-prompt';

describe('buildGitHubRoutingPrompt', () => {
  it('describes the GitHub follow-up mode classification contract', () => {
    const prompt = buildGitHubRoutingPrompt();

    expect(prompt).toContain('mentions @newmote');
    expect(prompt).toContain(
      'which routing mode a GitHub comment that mentions @newmote needs on the current pull request',
    );
    expect(prompt).toContain(
      'asking @newmote for review or follow-up work on the current pull request',
    );
    expect(prompt).toContain('review: run or reuse the PR review workflow');
    expect(prompt).toContain(
      'follow_up: any other actionable PR follow-up on the current pull request',
    );
    expect(prompt).toContain(
      'The execution layer will decide whether routed work should reuse an existing task or launch a new one',
    );
    expect(prompt).toContain(
      '`review` only when the user is clearly asking to run, rerun, or perform a PR review',
    );
    expect(prompt).toContain('"are all the issues addressed in this PR?"');
    expect(prompt).toContain(
      'if the user is not clearly asking for a review, choose `follow_up` instead',
    );
    expect(prompt).toContain(
      'Route the mention as `follow_up` unless it is clearly asking for a PR review',
    );
    expect(prompt).toContain('"followUpMode": "review" | "follow_up"');
  });

  describe('with a database-configured app slug', () => {
    beforeEach(() => {
      setConfiguredGitHubAppSlugCache({
        value: 'roomote-roomote',
        expiresAt: Date.now() + 60_000,
      });
    });

    afterEach(() => {
      setConfiguredGitHubAppSlugCache(null);
    });

    it('addresses the configured bot handle instead of the process-env slug', () => {
      const prompt = buildGitHubRoutingPrompt();

      expect(prompt).toContain('mentions @roomote-roomote');
      expect(prompt).not.toContain('@newmote');
    });
  });
});
