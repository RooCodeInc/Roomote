import { describe, expect, it } from 'vitest';

import {
  ROOMOTE_CREATOR_FILTER_VALUE,
  buildCreatorFilterValue,
  parseCreatorFilterValue,
} from './task-creator-filter';

describe('task creator filter helpers', () => {
  it('round-trips the Roomote creator filter value', () => {
    const value = buildCreatorFilterValue({
      effectiveAuthorKind: 'roomote',
      userId: null,
      attributionKind: 'automatic',
      attributionSourceKind: null,
      attributionSourceExternalId: null,
    });

    expect(value).toBe(ROOMOTE_CREATOR_FILTER_VALUE);
    expect(parseCreatorFilterValue(value ?? '')).toEqual({
      kind: 'roomote',
    });
  });

  it('round-trips unlinked creator filter values', () => {
    const value = buildCreatorFilterValue({
      effectiveAuthorKind: 'human',
      userId: null,
      attributionKind: 'unlinked_user',
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

  it('treats matched user ids as opaque filter values', () => {
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
