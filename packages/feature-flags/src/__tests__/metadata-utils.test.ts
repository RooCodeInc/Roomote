import { describe, expect, it } from 'vitest';

import { coerceToBoolean, normalizeMetadataRecord } from '../index';

describe('metadata utilities', () => {
  it('keeps generic boolean coercion behavior', () => {
    expect(coerceToBoolean(true)).toBe(true);
    expect(coerceToBoolean('TRUE')).toBe(true);
    expect(coerceToBoolean('false')).toBe(false);
    expect(coerceToBoolean(1)).toBe(true);
    expect(coerceToBoolean(0)).toBe(false);
  });

  it('normalizes invalid public metadata to an empty object', () => {
    expect(normalizeMetadataRecord(null)).toEqual({});
    expect(normalizeMetadataRecord([])).toEqual({});
    expect(normalizeMetadataRecord({ stale_flag: true })).toEqual({
      stale_flag: true,
    });
  });
});
