import { describe, expect, it } from 'vitest';

import {
  getCronOccurrence,
  isCronRunDue,
  normalizeTimeZone,
  validateCronExpression,
} from '../custom-automation-schedule';

describe('custom automation schedule helpers', () => {
  it('accepts standard five-field cron and rejects seconds or macros', () => {
    expect(validateCronExpression(' 0  9 * * 1-5 ', 'UTC')).toBe('0 9 * * 1-5');
    expect(() => validateCronExpression('0 0 9 * * 1-5', 'UTC')).toThrow(
      'five-field',
    );
    expect(() => validateCronExpression('@daily', 'UTC')).toThrow('five-field');
  });

  it('uses the configured timezone for the next occurrence', () => {
    const next = getCronOccurrence(
      '0 9 * * *',
      'America/Los_Angeles',
      'next',
      new Date('2026-08-02T12:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-08-02T16:00:00.000Z');
  });

  it('launches once when the latest occurrence is newer than the baseline', () => {
    const now = new Date('2026-08-02T12:01:00Z');
    expect(
      isCronRunDue({
        expression: '0 12 * * *',
        timeZone: 'UTC',
        now,
        baseline: new Date('2026-08-02T11:59:00Z'),
      }),
    ).toBe(true);
    expect(
      isCronRunDue({
        expression: '0 12 * * *',
        timeZone: 'UTC',
        now,
        baseline: new Date('2026-08-02T12:00:30Z'),
      }),
    ).toBe(false);
  });

  it('normalizes valid IANA timezones and rejects unknown values', () => {
    expect(normalizeTimeZone('America/New_York')).toBe('America/New_York');
    expect(() => normalizeTimeZone('Mars/Olympus')).toThrow('IANA');
  });
});
