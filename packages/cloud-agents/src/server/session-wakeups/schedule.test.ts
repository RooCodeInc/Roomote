import { describe, expect, it } from 'vitest';

import {
  SessionWakeupValidationError,
  computeNextSessionWakeupRunAt,
  describeSessionWakeupSchedule,
  normalizeSessionWakeupSchedule,
  resolveSessionWakeupNextRun,
  validateSessionWakeupCaps,
} from './schedule';

const now = new Date('2026-09-04T17:00:00.000Z');
const options = { now, defaultTimeZone: 'America/New_York' };

describe('normalizeSessionWakeupSchedule', () => {
  it.each([1, 10, 30, 31, 59, 61, 90, 299, 300])(
    'keeps %i seconds exact through first and next runs',
    (seconds) => {
      const inMinutes = seconds / 60;
      const once = normalizeSessionWakeupSchedule(
        { mode: 'once', inMinutes },
        options,
      );
      const interval = normalizeSessionWakeupSchedule(
        { mode: 'interval', everyMinutes: inMinutes },
        options,
      );
      expect(once.firstRunAt.getTime()).toBe(now.getTime() + seconds * 1000);
      expect(interval.firstRunAt).toEqual(once.firstRunAt);
      expect(computeNextSessionWakeupRunAt(once.schedule, now)).toEqual(
        once.firstRunAt,
      );
      expect(
        computeNextSessionWakeupRunAt(once.schedule, once.firstRunAt),
      ).toBeNull();
      expect(
        resolveSessionWakeupNextRun({
          schedule: interval.schedule,
          firedAt: once.firstRunAt,
          runCountAfterFire: 1,
          maxRuns: 2,
          until: null,
        })?.getTime(),
      ).toBe(now.getTime() + seconds * 2000);
      expect(
        resolveSessionWakeupNextRun({
          schedule: interval.schedule,
          firedAt: once.firstRunAt,
          runCountAfterFire: 2,
          maxRuns: 2,
          until: null,
        }),
      ).toBeNull();
      expect(
        resolveSessionWakeupNextRun({
          schedule: interval.schedule,
          firedAt: once.firstRunAt,
          runCountAfterFire: 1,
          maxRuns: null,
          until: once.firstRunAt,
        }),
      ).toBeNull();
    },
  );

  it.each([0, -1, NaN, Infinity, 0.001, 0.025, 43_201])(
    'rejects invalid normalized duration %s',
    (minutes) => {
      expect(() =>
        normalizeSessionWakeupSchedule(
          { mode: 'once', inMinutes: minutes },
          options,
        ),
      ).toThrow(SessionWakeupValidationError);
      expect(() =>
        normalizeSessionWakeupSchedule(
          { mode: 'interval', everyMinutes: minutes },
          options,
        ),
      ).toThrow(SessionWakeupValidationError);
    },
  );
  it('resolves a relative once schedule against now', () => {
    const result = normalizeSessionWakeupSchedule(
      { mode: 'once', inMinutes: 20 },
      options,
    );
    expect(result.firstRunAt.toISOString()).toBe('2026-09-04T17:20:00.000Z');
    expect(result.schedule).toEqual({
      mode: 'once',
      at: '2026-09-04T17:20:00.000Z',
      inMinutes: 20,
    });
  });

  it('accepts an absolute once schedule with an offset', () => {
    const result = normalizeSessionWakeupSchedule(
      { mode: 'once', at: '2026-09-04T15:00:00-04:00' },
      options,
    );
    expect(result.firstRunAt.toISOString()).toBe('2026-09-04T19:00:00.000Z');
  });

  it('prefers inMinutes when a computed at is sent alongside it', () => {
    expect(
      normalizeSessionWakeupSchedule(
        { mode: 'once', inMinutes: 5, at: '2026-09-04T18:00:00Z' },
        options,
      ).firstRunAt.toISOString(),
    ).toBe('2026-09-04T17:05:00.000Z');
  });

  it('rejects a once schedule with neither time field', () => {
    expect(() =>
      normalizeSessionWakeupSchedule({ mode: 'once' }, options),
    ).toThrow(SessionWakeupValidationError);
  });

  it('rejects a once schedule in the past and one beyond the horizon', () => {
    expect(() =>
      normalizeSessionWakeupSchedule(
        { mode: 'once', at: '2026-09-04T16:59:00Z' },
        options,
      ),
    ).toThrow(/must be in the future/);
    expect(() =>
      normalizeSessionWakeupSchedule(
        { mode: 'once', at: '2026-11-04T17:00:00Z' },
        options,
      ),
    ).toThrow(/30 days/);
  });

  it('schedules the first interval run one interval from now', () => {
    const result = normalizeSessionWakeupSchedule(
      { mode: 'interval', everyMinutes: 15 },
      options,
    );
    expect(result.firstRunAt.toISOString()).toBe('2026-09-04T17:15:00.000Z');
  });

  it('resolves cron in the deployment timezone by default', () => {
    const result = normalizeSessionWakeupSchedule(
      { mode: 'cron', expression: '0 9 * * 1-5' },
      options,
    );
    expect(result.schedule).toEqual({
      mode: 'cron',
      expression: '0 9 * * 1-5',
      timezone: 'America/New_York',
    });
    // 2026-09-04 is a Friday; 17:00Z is 13:00 in New York, so the next
    // weekday 9am is Monday 2026-09-07 09:00 EDT.
    expect(result.firstRunAt.toISOString()).toBe('2026-09-07T13:00:00.000Z');
  });

  it('rejects malformed cron and unknown timezones', () => {
    expect(() =>
      normalizeSessionWakeupSchedule(
        { mode: 'cron', expression: '0 9 * *' },
        options,
      ),
    ).toThrow(/five-field/);
    expect(() =>
      normalizeSessionWakeupSchedule(
        { mode: 'cron', expression: '0 9 * * *', timezone: 'Mars/Olympus' },
        options,
      ),
    ).toThrow(/timezone/);
  });
});

describe('resolveSessionWakeupNextRun', () => {
  it('ends a once schedule after it fires', () => {
    expect(
      resolveSessionWakeupNextRun({
        schedule: { mode: 'once', at: now.toISOString() },
        firedAt: now,
        runCountAfterFire: 1,
        maxRuns: null,
        until: null,
      }),
    ).toBeNull();
  });

  it('computes the next interval from the fire time, not the missed slot', () => {
    const firedAt = new Date('2026-09-04T20:03:00.000Z');
    expect(
      resolveSessionWakeupNextRun({
        schedule: { mode: 'interval', everyMinutes: 10 },
        firedAt,
        runCountAfterFire: 4,
        maxRuns: null,
        until: null,
      })?.toISOString(),
    ).toBe('2026-09-04T20:13:00.000Z');
  });

  it('honours maxRuns and until', () => {
    const schedule = { mode: 'interval' as const, everyMinutes: 10 };
    expect(
      resolveSessionWakeupNextRun({
        schedule,
        firedAt: now,
        runCountAfterFire: 3,
        maxRuns: 3,
        until: null,
      }),
    ).toBeNull();
    expect(
      resolveSessionWakeupNextRun({
        schedule,
        firedAt: now,
        runCountAfterFire: 1,
        maxRuns: null,
        until: new Date('2026-09-04T17:05:00.000Z'),
      }),
    ).toBeNull();
    expect(
      resolveSessionWakeupNextRun({
        schedule,
        firedAt: now,
        runCountAfterFire: 1,
        maxRuns: null,
        until: new Date('2026-09-04T18:00:00.000Z'),
      })?.toISOString(),
    ).toBe('2026-09-04T17:10:00.000Z');
  });
});

describe('validateSessionWakeupCaps', () => {
  it('ignores stray caps on a once schedule', () => {
    expect(() =>
      validateSessionWakeupCaps({
        schedule: { mode: 'once', at: now.toISOString() },
        firstRunAt: now,
        maxRuns: 2,
        until: null,
      }),
    ).not.toThrow();
  });

  it('requires a cap on tight intervals', () => {
    expect(() =>
      validateSessionWakeupCaps({
        schedule: { mode: 'interval', everyMinutes: 2 },
        firstRunAt: now,
        maxRuns: null,
        until: null,
      }),
    ).toThrow(/run count|end time/);
    expect(() =>
      validateSessionWakeupCaps({
        schedule: { mode: 'interval', everyMinutes: 2 },
        firstRunAt: now,
        maxRuns: 10,
        until: null,
      }),
    ).not.toThrow();
  });

  it('requires until to follow the first occurrence', () => {
    expect(() =>
      validateSessionWakeupCaps({
        schedule: { mode: 'interval', everyMinutes: 30 },
        firstRunAt: new Date('2026-09-04T17:30:00.000Z'),
        maxRuns: null,
        until: new Date('2026-09-04T17:10:00.000Z'),
      }),
    ).toThrow(/later than the first occurrence/);
  });
});

describe('describeSessionWakeupSchedule', () => {
  it('renders each mode for humans', () => {
    expect(
      describeSessionWakeupSchedule({ mode: 'interval', everyMinutes: 0.5 }),
    ).toBe('every 30 seconds');
    expect(
      describeSessionWakeupSchedule({ mode: 'interval', everyMinutes: 1 / 60 }),
    ).toBe('every 1 second');
    expect(
      describeSessionWakeupSchedule({
        mode: 'interval',
        everyMinutes: 61 / 60,
      }),
    ).toBe('every 61 seconds');
    expect(
      describeSessionWakeupSchedule({ mode: 'interval', everyMinutes: 90 }),
    ).toBe('every 90 minutes');
    expect(
      describeSessionWakeupSchedule({ mode: 'interval', everyMinutes: 120 }),
    ).toBe('every 2 hours');
    expect(
      describeSessionWakeupSchedule({ mode: 'interval', everyMinutes: 1440 }),
    ).toBe('every 1 day');
    expect(
      describeSessionWakeupSchedule({
        mode: 'cron',
        expression: '0 9 * * 1-5',
        timezone: 'UTC',
      }),
    ).toBe('cron 0 9 * * 1-5 (UTC)');
  });

  it('computes the next cron occurrence after a given time', () => {
    expect(
      computeNextSessionWakeupRunAt(
        { mode: 'cron', expression: '*/15 * * * *', timezone: 'UTC' },
        new Date('2026-09-04T17:01:00.000Z'),
      )?.toISOString(),
    ).toBe('2026-09-04T17:15:00.000Z');
  });
});
