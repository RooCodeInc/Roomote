import { getPrReviewTargetEligibility } from './pr-review-target-eligibility';

describe('getPrReviewTargetEligibility', () => {
  it.each([
    {
      name: 'allows non-review workflows',
      workflow: 'pr_conflict_resolve' as const,
      settings: { enabled: false, reviewAllPullRequestAuthors: false },
      ignoreAuthorPolicy: false,
      authorIsRoomoteManaged: false,
      expected: 'eligible',
    },
    {
      name: 'returns disabled for explicit settings',
      workflow: 'pr_review' as const,
      settings: { enabled: false },
      ignoreAuthorPolicy: false,
      authorIsRoomoteManaged: true,
      expected: 'automation_disabled',
    },
    {
      name: 'uses the disabled default when settings are absent',
      workflow: 'pr_review' as const,
      settings: null,
      ignoreAuthorPolicy: false,
      authorIsRoomoteManaged: true,
      expected: 'automation_disabled',
    },
    {
      name: 'allows an unknown author',
      workflow: 'pr_review' as const,
      settings: { enabled: true },
      ignoreAuthorPolicy: false,
      authorIsRoomoteManaged: null,
      expected: 'eligible',
    },
    {
      name: 'allows a Roomote-managed author',
      workflow: 'pr_review' as const,
      settings: { enabled: true },
      ignoreAuthorPolicy: false,
      authorIsRoomoteManaged: true,
      expected: 'eligible',
    },
    {
      name: 'rejects a human author by default',
      workflow: 'pr_review' as const,
      settings: { enabled: true },
      ignoreAuthorPolicy: false,
      authorIsRoomoteManaged: false,
      expected: 'author_not_allowed',
    },
    {
      name: 'allows all authors when configured',
      workflow: 'pr_review' as const,
      settings: { enabled: true, reviewAllPullRequestAuthors: true },
      ignoreAuthorPolicy: false,
      authorIsRoomoteManaged: false,
      expected: 'eligible',
    },
    {
      name: 'allows a human author when policy is ignored',
      workflow: 'pr_review' as const,
      settings: { enabled: true, reviewAllPullRequestAuthors: false },
      ignoreAuthorPolicy: true,
      authorIsRoomoteManaged: false,
      expected: 'eligible',
    },
  ])('$name', ({ expected, ...options }) => {
    expect(
      getPrReviewTargetEligibility(
        options.workflow,
        options.settings,
        options.ignoreAuthorPolicy,
        options.authorIsRoomoteManaged,
      ),
    ).toBe(expected);
  });
});
