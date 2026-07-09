import { describe, expect, it } from 'vitest';

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

  it('lumps unlinked external identities into Automations', () => {
    expect(
      getCanonicalTaskAttributionDimensionValue({
        attributionKind: 'unlinked_user',
        attributedUserId: null,
        attributionSourceKind: 'github',
        attributionSourceDisplayName: 'openmote[bot]',
        attributionSourceExternalId: 'openmote[bot]',
        attributedGithubLogin: 'openmote[bot]',
        effectiveAuthorKind: null,
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

  it('lumps automatic/system authors into Automations', () => {
    expect(
      getCanonicalTaskAttributionDimensionValue({
        attributionKind: 'automatic',
        attributedUserId: null,
        attributionSourceKind: 'automation',
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

  it('keys matched users on effective author when it differs from attributed', () => {
    expect(
      getCanonicalTaskAttributionDimensionValue({
        attributionKind: 'matched_user',
        attributedUserId: 'attributed-1',
        attributionSourceKind: 'github',
        attributionSourceDisplayName: null,
        attributionSourceExternalId: null,
        attributedGithubLogin: 'someone',
        effectiveAuthorKind: 'human',
        effectiveAuthorUserId: 'effective-1',
        effectiveAuthorDisplayName: 'Effective Person',
        effectiveAuthorGithubLogin: 'effective',
        userName: 'Attributed Person',
        userEmail: 'attributed@example.com',
      }),
    ).toEqual({
      key: 'user:effective-1',
      label: 'Effective Person',
    });
  });

  it('merges distinct non-matched sources into the same Automations key', () => {
    const bot = getCanonicalTaskAttributionDimensionValue({
      attributionKind: 'unlinked_user',
      attributedUserId: null,
      attributionSourceKind: 'github',
      attributionSourceDisplayName: 'openmote[bot]',
      attributionSourceExternalId: 'openmote[bot]',
      attributedGithubLogin: 'openmote[bot]',
      effectiveAuthorKind: null,
      effectiveAuthorUserId: null,
      effectiveAuthorDisplayName: null,
      effectiveAuthorGithubLogin: null,
      userName: null,
      userEmail: null,
    });
    const roomote = getCanonicalTaskAttributionDimensionValue({
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
    });

    expect(bot.key).toBe(AUTOMATIONS_USER_DIMENSION_KEY);
    expect(roomote.key).toBe(AUTOMATIONS_USER_DIMENSION_KEY);
    expect(bot.key).toBe(roomote.key);
  });
});
