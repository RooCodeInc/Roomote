import { describe, expect, it } from 'vitest';

import {
  getCronOccurrence,
  getCustomAutomationNextRunAt,
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
      'America/New_York',
      'next',
      new Date('2026-08-01T00:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-08-01T13:00:00.000Z');
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

  it('resolves cron and daily occurrences in the deployment timezone', () => {
    const common = {
      enabled: true,
      timeZone: 'America/New_York',
      timeZoneUpdatedAt: null,
      lastRunAt: null,
      createdAt: new Date('2026-09-10T00:00:00Z'),
      now: new Date('2026-09-10T06:55:00Z'),
    };
    expect(
      getCustomAutomationNextRunAt({
        ...common,
        scheduleMode: 'cron',
        cronExpression: '0 9 * * *',
      })?.toISOString(),
    ).toBe('2026-09-10T13:00:00.000Z');
    expect(
      getCustomAutomationNextRunAt({
        ...common,
        scheduleMode: 'daily',
        cronExpression: null,
      })?.toISOString(),
    ).toBe('2026-09-10T07:00:00.000Z');
  });

  it('moves daily schedules to the next local day after a timezone change', () => {
    expect(
      getCustomAutomationNextRunAt({
        enabled: true,
        scheduleMode: 'daily',
        cronExpression: null,
        timeZone: 'America/New_York',
        timeZoneUpdatedAt: new Date('2026-09-10T06:30:00Z'),
        lastRunAt: new Date('2026-09-09T07:00:00Z'),
        createdAt: new Date('2026-09-01T00:00:00Z'),
        now: new Date('2026-09-10T06:55:00Z'),
      })?.toISOString(),
    ).toBe('2026-09-11T07:00:00.000Z');
  });

  it('anchors interval presets to the latest run or timezone change', () => {
    const common = {
      enabled: true,
      cronExpression: null,
      timeZone: 'America/Los_Angeles',
      timeZoneUpdatedAt: new Date('2026-09-10T10:30:00Z'),
      lastRunAt: new Date('2026-09-10T08:00:00Z'),
      createdAt: new Date('2026-09-01T00:00:00Z'),
      now: new Date('2026-09-10T12:00:00Z'),
    };
    expect(
      getCustomAutomationNextRunAt({
        ...common,
        scheduleMode: 'every_hour',
      })?.toISOString(),
    ).toBe('2026-09-10T12:30:00.000Z');
    expect(
      getCustomAutomationNextRunAt({
        ...common,
        scheduleMode: 'every_6_hours',
      })?.toISOString(),
    ).toBe('2026-09-10T16:30:00.000Z');
    expect(
      getCustomAutomationNextRunAt({
        ...common,
        scheduleMode: 'weekly',
      })?.toISOString(),
    ).toBe('2026-09-17T10:30:00.000Z');
  });

  it.each([
    { enabled: false, scheduleMode: 'daily' as const },
    { enabled: true, scheduleMode: 'off' as const },
  ])('omits a next run for disabled schedules', (schedule) => {
    expect(
      getCustomAutomationNextRunAt({
        ...schedule,
        cronExpression: null,
        timeZone: 'UTC',
        timeZoneUpdatedAt: null,
        lastRunAt: null,
        createdAt: new Date('2026-09-10T00:00:00Z'),
        now: new Date('2026-09-10T01:00:00Z'),
      }),
    ).toBeNull();
  });

  it('omits invalid saved cron schedules instead of breaking the list', () => {
    expect(
      getCustomAutomationNextRunAt({
        enabled: true,
        scheduleMode: 'cron',
        cronExpression: '99 99 * * *',
        timeZone: 'UTC',
        timeZoneUpdatedAt: null,
        lastRunAt: null,
        createdAt: new Date('2026-09-10T00:00:00Z'),
        now: new Date('2026-09-10T01:00:00Z'),
      }),
    ).toBeNull();
  });
});
