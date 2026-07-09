import { describe, expect, it } from 'vitest';
import {
  CloudTaskType,
  PRODUCT_NAME,
  resolveTaskAutomationDisplayName,
} from '@roomote/types';

import {
  AUTOMATIONS_USER_DIMENSION_KEY,
  AUTOMATIONS_USER_DIMENSION_LABEL,
  getCanonicalTaskAttributionDimensionValue,
} from './analytics-task-user-dimension';

describe('getCanonicalTaskAttributionDimensionValue', () => {
  it('keeps matched users as their own series', () => {
    expect(
      getCanonicalTaskAttributionDimensionValue({
        attributionKind: 'matched_user',
        attributedUserId: 'user-1',
        attributionSourceKind: 'web',
        attributionSourceDisplayName: null,
        attributionSourceExternalId: null,
        attributedGithubLogin: null,
        effectiveAuthorKind: 'human',
        effectiveAuthorUserId: 'user-1',
        effectiveAuthorDisplayName: 'Matt Rubens',
        effectiveAuthorGithubLogin: 'mrubens',
        userName: 'Matt Rubens',
        userEmail: 'matt@example.com',
      }),
    ).toEqual({
      key: 'user:user-1',
      label: 'Matt Rubens',
      disambiguationLabel: 'Matt Rubens (matt@example.com)',
    });
  });

  it('uses named automation series for automatic attribution', () => {
    expect(
      getCanonicalTaskAttributionDimensionValue({
        attributionKind: 'automatic',
        attributedUserId: null,
        attributionSourceKind: 'automation',
        attributionSourceDisplayName: 'PR Reviewer',
        attributionSourceExternalId: null,
        attributedGithubLogin: null,
        effectiveAuthorKind: null,
        effectiveAuthorUserId: null,
        effectiveAuthorDisplayName: null,
        effectiveAuthorGithubLogin: null,
        userName: null,
        userEmail: null,
      }),
    ).toEqual({
      key: 'automation:PR Reviewer',
      label: 'PR Reviewer',
    });
  });

  it('falls back to Automations when automatic has no specific name', () => {
    expect(
      getCanonicalTaskAttributionDimensionValue({
        attributionKind: 'automatic',
        attributedUserId: null,
        attributionSourceKind: 'system',
        attributionSourceDisplayName: null,
        attributionSourceExternalId: null,
        attributedGithubLogin: null,
        effectiveAuthorKind: 'roomote',
        effectiveAuthorUserId: null,
        effectiveAuthorDisplayName: null,
        effectiveAuthorGithubLogin: null,
        userName: null,
        userEmail: null,
      }),
    ).toEqual({
      key: AUTOMATIONS_USER_DIMENSION_KEY,
      label: AUTOMATIONS_USER_DIMENSION_LABEL,
    });
  });

  it('keeps unlinked external identities distinct', () => {
    expect(
      getCanonicalTaskAttributionDimensionValue({
        attributionKind: 'unlinked_user',
        attributedUserId: null,
        attributionSourceKind: 'github',
        attributionSourceDisplayName: 'octocat',
        attributionSourceExternalId: 'octocat',
        attributedGithubLogin: 'octocat',
        effectiveAuthorKind: null,
        effectiveAuthorUserId: null,
        effectiveAuthorDisplayName: null,
        effectiveAuthorGithubLogin: null,
        userName: null,
        userEmail: null,
      }),
    ).toEqual({
      key: 'unlinked:github:octocat',
      label: 'octocat',
    });
  });
});

describe('resolveTaskAutomationDisplayName', () => {
  it('names PR review and Conflict resolver automations', () => {
    expect(
      resolveTaskAutomationDisplayName({
        type: CloudTaskType.GithubPrReview,
      }),
    ).toBe('PR Reviewer');
    expect(
      resolveTaskAutomationDisplayName({
        type: CloudTaskType.GithubPrConflictResolve,
      }),
    ).toBe('Resolve PR Conflicts');
  });

  it('names scheduled suggestion automations from suggestionSource', () => {
    expect(
      resolveTaskAutomationDisplayName({
        type: CloudTaskType.SuggestedTasks,
        payload: { suggestionSource: 'suggest_ideas' },
      }),
    ).toBe('Suggest Ideas');
    expect(
      resolveTaskAutomationDisplayName({
        type: CloudTaskType.SuggestedTasks,
        payload: { suggestionSource: 'dependabot_triage' },
      }),
    ).toBe('Triage Dependabot Alerts');
  });

  it('returns null when no automation identity is available', () => {
    expect(
      resolveTaskAutomationDisplayName({
        type: CloudTaskType.StandardTask,
        payload: { repo: 'owner/repo' } as never,
      }),
    ).toBeNull();
    expect(PRODUCT_NAME).toBeTruthy();
  });
});
