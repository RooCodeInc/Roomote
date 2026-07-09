import { describe, expect, it } from 'vitest';

import {
  AUTOMATIONS_CREATOR_FILTER_VALUE,
  buildAutomationCreatorFilterValue,
  buildMatchedUserCreatorFilterValue,
  buildUnlinkedCreatorFilterValue,
  parseCreatorFilterValue,
} from './task-creator-filter';

describe('task creator filter helpers', () => {
  it('round-trips the shared Automations bucket value', () => {
    expect(parseCreatorFilterValue(AUTOMATIONS_CREATOR_FILTER_VALUE)).toEqual({
      kind: 'automations',
    });
  });

  it('round-trips named automation filter values', () => {
    const value = buildAutomationCreatorFilterValue('PR Reviewer');

    expect(value).toBe('automation:PR%20Reviewer');
    expect(parseCreatorFilterValue(value)).toEqual({
      kind: 'automation',
      label: 'PR Reviewer',
    });
  });

  it('falls back to the Automations bucket for empty automation labels', () => {
    expect(parseCreatorFilterValue('automation:')).toEqual({
      kind: 'automations',
    });
  });

  it('round-trips unlinked creator filter values', () => {
    const value = buildUnlinkedCreatorFilterValue({
      attributionSourceKind: 'slack',
      attributionSourceExternalId: 'U123',
    });

    expect(value).toBe('unlinked:slack:U123');
    expect(parseCreatorFilterValue(value ?? '')).toEqual({
      kind: 'unlinked_user',
      sourceKind: 'slack',
      sourceExternalId: 'U123',
    });
  });

  it('returns null unlinked values when the identity is incomplete', () => {
    expect(
      buildUnlinkedCreatorFilterValue({
        attributionSourceKind: 'slack',
        attributionSourceExternalId: null,
      }),
    ).toBeNull();
  });

  it('treats matched user ids as opaque filter values', () => {
    expect(buildMatchedUserCreatorFilterValue('user_123')).toBe('user_123');
    expect(parseCreatorFilterValue('user_123')).toEqual({
      kind: 'matched_user',
      userId: 'user_123',
    });
  });

  it('falls back to the opaque matched-user path for malformed unlinked values', () => {
    expect(parseCreatorFilterValue('unlinked:slack:%E0%A4%A')).toEqual({
      kind: 'matched_user',
      userId: 'unlinked:slack:%E0%A4%A',
    });
  });
});
