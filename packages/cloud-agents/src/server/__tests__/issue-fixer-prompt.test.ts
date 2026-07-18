import { describe, expect, it } from 'vitest';

import { buildIssueFixerFixPrompt } from '../issue-fixer-prompt';

describe('buildIssueFixerFixPrompt', () => {
  it('injects the configured GitHub app mention into comment templates', () => {
    const prompt = buildIssueFixerFixPrompt({
      repositoryFullName: 'acme/api',
      environmentId: 'env-api',
      trigger: 'webhook',
      githubAppSlug: 'roomote-roomote',
      repositoryCoverage: [
        { repositoryFullName: 'acme/api', targetEnvironmentId: 'env-api' },
      ],
      issue: {
        repositoryFullName: 'acme/api',
        number: 12,
        title: 'Broken checkout',
        url: 'https://github.com/acme/api/issues/12',
        body: 'Checkout fails on empty carts.',
        labels: ['bug'],
        authorLogin: 'alice',
      },
    });

    expect(prompt).toContain(
      '<github_app_mention>@roomote-roomote</github_app_mention>',
    );
    expect(prompt).toContain(
      'Please tag @roomote-roomote in your response with the answers',
    );
    expect(prompt).toContain(
      "Please tag @roomote-roomote if you'd like me to implement this",
    );
    expect(prompt).not.toContain('Please tag @roomote in your response');
    expect(prompt).not.toContain("Please tag @roomote if you'd like me");
  });
});
