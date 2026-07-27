import { standardTask } from '../standardTask';
import { ALL_REPOSITORIES } from '@roomote/types';

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
      'are doing a self-review on GitHub',
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
      'Code Reviewer is enabled for this deployment',
    );
    expect(harnessInstructions).toContain(
      'When you share a newly created or refreshed pull request or merge request link back to the originating chat or communications channel',
    );
    expect(harnessInstructions).toContain(
      'are doing a self-review on GitHub and will follow up here with those results',
    );
    expect(harnessInstructions).toContain(
      'Do not perform that Code Reviewer self-review yourself in this task.',
    );
    expect(harnessInstructions).toContain(
      'Do not open a PR review, post inline review comments, invoke `review-code`/`review-and-fix` for that purpose',
    );
    expect(harnessInstructions).toContain(
      'Do not mention separate agents, automated reviewer tasks, or internal review plumbing in that user-facing note.',
    );
    expect(harnessInstructions).toContain(
      'Judge from the PR you actually opened or refreshed (including after explicit `$create-pr` / `$create-draft-pr` overrides)',
    );
    expect(harnessInstructions).not.toContain(
      'a separate automated self-review will run',
    );
  });

  it('omits self-review follow-up guidance for unsupported source-control surfaces', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      codeReviewsEnabled: true,
      sourceControlProvider: 'gitlab',
      taskSurface: 'gitlab',
    });

    expect(harnessInstructions).not.toContain(
      '<code_review_self_review_closeout>',
    );
    expect(harnessInstructions).not.toContain(
      'are doing a self-review on GitLab and will follow up here with those results',
    );
  });

  it('omits self-review follow-up guidance for all-repositories tasks', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: ALL_REPOSITORIES,
      taskRunUrl: 'https://example.com/task/123',
      codeReviewsEnabled: true,
      sourceControlProvider: 'github',
      taskSurface: 'slack',
    });

    expect(harnessInstructions).not.toContain(
      '<code_review_self_review_closeout>',
    );
    expect(harnessInstructions).not.toContain(
      'are doing a self-review on GitHub and will follow up here with those results',
    );
  });

  it('keeps self-review follow-up guidance for GitHub source-control tasks', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      codeReviewsEnabled: true,
      sourceControlProvider: 'github',
      taskSurface: 'github',
    });

    expect(harnessInstructions).toContain(
      'are doing a self-review on GitHub and will follow up here with those results',
    );
  });

  it('infers GitHub self-review guidance from the task surface', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      codeReviewsEnabled: true,
      taskSurface: 'github',
    });

    expect(harnessInstructions).toContain('<code_review_self_review_closeout>');
    expect(harnessInstructions).toContain(
      'are doing a self-review on GitHub and will follow up here with those results',
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
      'are doing a self-review on GitHub/GitLab and will follow up here with those results',
    );
  });

  it('folds the self-review note into background-proof closeout text when every PR shape is auto-review eligible', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      backgroundProofCaptureEnabled: true,
      codeReviewsEnabled: true,
      codeReviewReviewDraftPrs: true,
      sourceControlProvider: 'github',
    });

    expect(harnessInstructions).toContain(
      'post the closeout noting the pull request link and that visual proof is being captured in the background and will follow in this thread and that you are doing a self-review on GitHub and will follow up here with those results',
    );
  });

  it('does not hard-require a self-review note on push-only closeouts even when code reviews and background proof are enabled', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      backgroundProofCaptureEnabled: true,
      codeReviewsEnabled: true,
      sourceControlProvider: 'github',
      prAction: 'push',
    });

    expect(harnessInstructions).toContain(
      'post the closeout noting the pull request link and that visual proof is being captured in the background and will follow in this thread. The parent must not load or directly use browser tooling',
    );
    expect(harnessInstructions).not.toContain(
      'post the closeout noting the pull request link and that visual proof is being captured in the background and will follow in this thread and that you are doing a self-review on GitHub and will follow up here with those results',
    );
  });

  it('omits the automatic self-review notice when reviewOnCommit is disabled', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      backgroundProofCaptureEnabled: true,
      codeReviewsEnabled: true,
      codeReviewReviewOnCommit: false,
      sourceControlProvider: 'github',
    });

    expect(harnessInstructions).not.toContain(
      '<code_review_self_review_closeout>',
    );
    expect(harnessInstructions).not.toContain(
      'are doing a self-review on GitHub',
    );
    expect(harnessInstructions).toContain(
      'post the closeout noting the pull request link and that visual proof is being captured in the background and will follow in this thread. The parent must not load or directly use browser tooling',
    );
  });

  it('keeps decision guidance for draft default delivery when reviewDraftPrs is disabled without hard-appending the note', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      backgroundProofCaptureEnabled: true,
      codeReviewsEnabled: true,
      codeReviewReviewOnCommit: true,
      codeReviewReviewDraftPrs: false,
      sourceControlProvider: 'github',
      // default prAction is draft delivery
    });

    expect(harnessInstructions).toContain('<code_review_self_review_closeout>');
    expect(harnessInstructions).toContain(
      'Draft automatic review is disabled for this deployment',
    );
    expect(harnessInstructions).toContain(
      'Judge from the PR you actually opened or refreshed (including after explicit `$create-pr` / `$create-draft-pr` overrides)',
    );
    expect(harnessInstructions).not.toContain(
      'post the closeout noting the pull request link and that visual proof is being captured in the background and will follow in this thread and that you are doing a self-review on GitHub and will follow up here with those results',
    );
  });

  it('does not hard-append the self-review note for ready-for-review delivery when draft reviews are off', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      backgroundProofCaptureEnabled: true,
      codeReviewsEnabled: true,
      codeReviewReviewOnCommit: true,
      codeReviewReviewDraftPrs: false,
      sourceControlProvider: 'github',
      prAction: 'create',
    });

    // `$create-draft-pr` can still override to a non-eligible draft, so keep
    // decision guidance without hard-appending a forced promise.
    expect(harnessInstructions).toContain('<code_review_self_review_closeout>');
    expect(harnessInstructions).toContain(
      'Judge from the PR you actually opened or refreshed (including after explicit `$create-pr` / `$create-draft-pr` overrides)',
    );
    expect(harnessInstructions).not.toContain(
      'post the closeout noting the pull request link and that visual proof is being captured in the background and will follow in this thread and that you are doing a self-review on GitHub and will follow up here with those results',
    );
  });
});
