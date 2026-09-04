import { describe, expect, it } from 'vitest';

import { parseSessionWakeupSchedule } from './parse';
import { SessionWakeupValidationError } from './schedule';

const now = new Date('2026-09-04T17:00:00.000Z');
const options = { now, defaultTimeZone: 'America/New_York' };

describe('parseSessionWakeupSchedule', () => {
  it('reads one-shot delays in several spellings', () => {
    for (const text of ['in 2m', 'in 2 minutes', 'IN 2min', 'once in 2m']) {
      const parsed = parseSessionWakeupSchedule(text, options);
      expect(parsed.schedule).toEqual({
        mode: 'once',
        at: '2026-09-04T17:02:00.000Z',
      });
      expect(parsed.maxRuns).toBeNull();
      expect(parsed.until).toBeNull();
    }
    expect(
      parseSessionWakeupSchedule('in 3h', options).firstRunAt.toISOString(),
    ).toBe('2026-09-04T20:00:00.000Z');
    expect(
      parseSessionWakeupSchedule('in 2 days', options).firstRunAt.toISOString(),
    ).toBe('2026-09-06T17:00:00.000Z');
  });

  it('reads an absolute one-shot time', () => {
    expect(
      parseSessionWakeupSchedule(
        'at 2026-09-04T15:00:00-04:00',
        options,
      ).firstRunAt.toISOString(),
    ).toBe('2026-09-04T19:00:00.000Z');
  });

  it('reads intervals with run counts and end times in either order', () => {
    const plain = parseSessionWakeupSchedule('every 10m', options);
    expect(plain.schedule).toEqual({ mode: 'interval', everyMinutes: 10 });
    expect(plain.maxRuns).toBeNull();

    for (const text of [
      'every 1m x3',
      'every 1m x 3',
      'every 1 minute 3 times',
      'every minute for 3 runs',
    ]) {
      const parsed = parseSessionWakeupSchedule(text, options);
      expect(parsed.schedule).toEqual({ mode: 'interval', everyMinutes: 1 });
      expect(parsed.maxRuns).toBe(3);
    }

    const both = parseSessionWakeupSchedule(
      'every 10m until 2026-09-04T18:00:00Z x5',
      options,
    );
    expect(both.maxRuns).toBe(5);
    expect(both.until?.toISOString()).toBe('2026-09-04T18:00:00.000Z');
    expect(
      parseSessionWakeupSchedule('every 6 hours', options).schedule,
    ).toEqual({ mode: 'interval', everyMinutes: 360 });
  });

  it('reads cron with an optional timezone', () => {
    expect(
      parseSessionWakeupSchedule('cron 0 9 * * 1-5', options).schedule,
    ).toEqual({
      mode: 'cron',
      expression: '0 9 * * 1-5',
      timezone: 'America/New_York',
    });
    expect(
      parseSessionWakeupSchedule('cron 0 9 * * 1-5 Europe/Berlin', options)
        .schedule,
    ).toEqual({
      mode: 'cron',
      expression: '0 9 * * 1-5',
      timezone: 'Europe/Berlin',
    });
  });

  it('enforces the tight-interval cap through the string form', () => {
    expect(() => parseSessionWakeupSchedule('every 1m', options)).toThrow(
      /x<count>|until/,
    );
    expect(() =>
      parseSessionWakeupSchedule('every 1m x3', options),
    ).not.toThrow();
  });

  it('rejects unreadable schedules with the grammar in the message', () => {
    for (const text of ['', 'tomorrow', '2m', 'every', 'in two minutes']) {
      expect(() => parseSessionWakeupSchedule(text, options)).toThrow(
        SessionWakeupValidationError,
      );
    }
    expect(() => parseSessionWakeupSchedule('2m', options)).toThrow(
      /say "in \.\.\."/,
    );
    expect(() => parseSessionWakeupSchedule('soon', options)).toThrow(
      /"in <n>m\|h\|d"/,
    );
    expect(() =>
      parseSessionWakeupSchedule('every 10m until soon', options),
    ).toThrow(/ISO 8601/);
    expect(() =>
      parseSessionWakeupSchedule('every 10m banana', options),
    ).toThrow(/unexpected "banana"/);
  });
});
