import { standardTask } from '../standardTask';

describe('Standard Task code-review self-review closeout', () => {
  it('omits self-review closeout guidance when code reviews are disabled or omitted', () => {
    const baseInput = {
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      sourceControlProvider: 'github' as const,
    };

    const defaultInstructions = standardTask(baseInput).harnessInstructions;
    const disabledInstructions = standardTask({
      ...baseInput,
      codeReviewsEnabled: false,
    }).harnessInstructions;

    expect(disabledInstructions).toBe(defaultInstructions);
    expect(disabledInstructions).not.toContain(
      '<code_review_self_review_closeout>',
    );
    expect(disabledInstructions).not.toContain(
      'plan to do a self-review on GitHub',
    );
  });

  it('injects self-review expectation guidance when code reviews are enabled', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      codeReviewsEnabled: true,
      sourceControlProvider: 'github',
      taskSurface: 'discord',
    });

    expect(harnessInstructions).toContain('<code_review_self_review_closeout>');
    expect(harnessInstructions).toContain(
      'Code Reviewer is enabled for this deployment.',
    );
    expect(harnessInstructions).toContain(
      'When you share a newly created or refreshed pull request or merge request link back to the originating chat or communications channel',
    );
    expect(harnessInstructions).toContain(
      'plan to do a self-review on GitHub and will follow up here with those results',
    );
    expect(harnessInstructions).toContain(
      'Do not claim the self-review is already finished unless it actually finished in this same turn.',
    );
  });

  it('names GitLab when the source-control provider is GitLab', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      codeReviewsEnabled: true,
      sourceControlProvider: 'gitlab',
    });

    expect(harnessInstructions).toContain(
      'plan to do a self-review on GitLab and will follow up here with those results',
    );
  });

  it('falls back to GitHub/GitLab when no source-control provider is set', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      codeReviewsEnabled: true,
    });

    expect(harnessInstructions).toContain(
      'plan to do a self-review on GitHub/GitLab and will follow up here with those results',
    );
  });

  it('folds the self-review note into background-proof closeout text when both flags are on', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      backgroundProofCaptureEnabled: true,
      codeReviewsEnabled: true,
      sourceControlProvider: 'github',
    });

    expect(harnessInstructions).toContain(
      'post the closeout noting the pull request link and that visual proof is being captured in the background and will follow in this thread and that you plan to do a self-review on GitHub and will follow up here with those results',
    );
  });
});
